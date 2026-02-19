/**
 * =============================================================================
 * BDRAM Scanner - Chain Walker
 *
 * Pure functions — no class, no shared state.
 *
 * Both static and dynamic list detection share the same structural operation:
 * walk a pool of addresses forward through a fixed offset, find chains,
 * and resolve conflicts when chains share nodes.
 *
 * The only behavioural differences are:
 *   - How you look up the pointer value for an address  (getVal callback)
 *   - Whether ghost bridging is allowed                 (opts.maxGhostNodes)
 *   - Whether hitting a target pool ends the chain      (opts.targetPool)
 *
 * Ghost node semantics
 * --------------------
 * A ghost is a node that *should* be at address (val + offset) according to
 * the chain logic but is absent from the pool — it was present in memory but
 * not captured in the scan.
 *
 * Bridging works strictly along the chain's pointer direction:
 *
 *   current node at addr A with value V
 *   expected next addr = V + offset          ← not in pool → possible ghost
 *   ghost address recorded: V + offset
 *   check if (V + offset) + offset is in pool  → if yes, bridge 1 ghost
 *   check if (V + offset) + 2*offset is in pool → bridge 2 ghosts, etc.
 *
 * We do NOT use address arithmetic on A (the current node's address).
 * Ghost slots are strictly: expected, expected+offset, expected+2*offset, …
 * The chain resumes at the first of those that IS in the pool.
 *
 * maxGhostNodes caps the total ghosts across the entire chain, not per gap.
 * =============================================================================
 */

'use strict';

/**
 * Walk chains at a fixed offset through a pool of addresses.
 *
 * @param {Set<number>}   pool            Addresses available this pass.
 * @param {number}        offset          Byte offset to follow (e.g. 0, 4, 8 …).
 * @param {function}      getVal          addr → number|undefined
 *                                        Returns the pointer value stored at addr,
 *                                        or undefined if addr has no entry.
 * @param {object}        opts
 * @param {number}        opts.minChainLength  Minimum valid nodes to keep a chain.
 * @param {number}        [opts.maxGhostNodes=0]
 *                                        Maximum ghost nodes allowed across the
 *                                        whole chain. 0 = ghosts disabled.
 * @param {Set<number>}   [opts.targetPool=null]
 *                                        If provided, a chain that walks INTO
 *                                        this set stops immediately and is
 *                                        returned as an entry point, not a chain.
 *
 * @returns {{ chains: object[], entryPoints: object[] }}
 *
 *   chains[]      { nodes: number[], ghosts: number[], isHead: true }
 *   entryPoints[] { nodes: number[], ghosts: number[] }
 *                 (only produced when targetPool is provided and hit)
 */
function walkChainsAtOffset(pool, offset, getVal, opts = {}) {
    const {
        minChainLength,
        maxGhostNodes = 0,
        targetPool    = null
    } = opts;

    const chains      = [];
    const entryPoints = [];
    const processed   = new Set();

    // -------------------------------------------------------------------------
    // Build the pointed-to set so we can identify true head nodes.
    // A head node is one that no other pool node points to at this offset.
    // -------------------------------------------------------------------------
    const pointedTo = new Set();
    for (const addr of pool) {
        const val = getVal(addr);
        if (val === undefined) continue;
        const child = val + offset;
        if (pool.has(child)) pointedTo.add(child);
    }

    // -------------------------------------------------------------------------
    // Walk from each head node.
    // -------------------------------------------------------------------------
    for (const startAddr of pool) {
        if (processed.has(startAddr))    continue;  // already claimed
        if (pointedTo.has(startAddr))    continue;  // not a head
        if (getVal(startAddr) === undefined) continue;

        const nodes       = [];
        const ghosts      = [];
        const visited     = new Set();
        let   current     = startAddr;
        let   hitTarget   = false;
        let   totalGhosts = 0;

        // Walk forward along the chain.
        chainLoop: while (true) {
            if (visited.has(current)) break;          // circular reference

            // Check if we walked into the target pool (dynamic mode only).
            if (targetPool !== null && targetPool.has(current)) {
                hitTarget = true;
                break;
            }

            if (!pool.has(current)) break;            // left the available pool

            const val = getVal(current);
            if (val === undefined) break;

            nodes.push(current);
            visited.add(current);

            const expected = val + offset;            // where the chain should go next

            if (pool.has(expected)) {
                current = expected;
                continue;
            }

            // ---------------------------------------------------------------
            // expected is not in the pool — attempt ghost bridging.
            // We walk forward from expected in steps of offset, recording each
            // missing address as a ghost, until we find a real pool node or
            // exhaust the ghost budget.
            // ---------------------------------------------------------------
            if (maxGhostNodes === 0) break;           // ghosts disabled

            let bridgeAddr = expected;                // starts at the first missing node
            let foundBridgeTarget = null;
            let newGhostCount = 0;

            for (let g = 0; g < maxGhostNodes; g++) {
                const afterBridge = bridgeAddr + offset;
                if (pool.has(afterBridge)) {
                    foundBridgeTarget = afterBridge;
                    newGhostCount = g + 1;            // g+1 ghosts: expected … bridgeAddr
                    break;
                }
                bridgeAddr += offset;
            }

            if (foundBridgeTarget === null) break;    // no bridge found

            // Would accepting these ghosts push us over the total budget?
            if (totalGhosts + newGhostCount > maxGhostNodes) break;

            // Record the ghost addresses: expected, expected+offset, …, bridgeAddr
            for (let k = 0; k < newGhostCount; k++) {
                ghosts.push(expected + k * offset);
            }
            totalGhosts += newGhostCount;
            current = foundBridgeTarget;
        }

        // Mark all walked addresses as processed so later heads don't re-walk them.
        for (const n of nodes) processed.add(n);

        if (hitTarget && nodes.length >= 1) {
            // Dynamic entry point: chain reached a known target before completing.
            entryPoints.push({ nodes: [...nodes], ghosts: [...ghosts] });
        } else if (nodes.length >= minChainLength) {
            chains.push({ nodes: [...nodes], ghosts: [...ghosts], isHead: true });
        }
    }

    return { chains, entryPoints };
}

/**
 * Resolve conflicts between chains that share nodes.
 *
 * Winner rule: longest chain wins. Ties broken by smallest root address.
 * Losing chains with enough nodes are returned with isHead: false so the
 * caller can treat them as secondary entry points if needed.
 *
 * @param {object[]} chains  Output from walkChainsAtOffset().chains
 * @returns {object[]}       Same shape; each entry gains an `isHead` boolean.
 */
function resolveChainConflicts(chains) {
    if (chains.length === 0) return [];
    if (chains.length === 1) return chains;

    // Map each node address → array of chain indexes that contain it.
    const nodeToChains = new Map();
    for (let i = 0; i < chains.length; i++) {
        for (const node of chains[i].nodes) {
            if (!nodeToChains.has(node)) nodeToChains.set(node, []);
            nodeToChains.get(node).push(i);
        }
    }

    const resolved  = [];
    const processed = new Set();

    for (let i = 0; i < chains.length; i++) {
        if (processed.has(i)) continue;

        const conflicts = new Set();
        for (const node of chains[i].nodes) {
            for (const ci of (nodeToChains.get(node) || [])) {
                if (ci !== i) conflicts.add(ci);
            }
        }

        const group = [i, ...conflicts].map(idx => ({ idx, chain: chains[idx] }));

        // Longest wins; smallest root address breaks ties.
        group.sort((a, b) => {
            const lenDiff = b.chain.nodes.length - a.chain.nodes.length;
            if (lenDiff !== 0) return lenDiff;
            return a.chain.nodes[0] - b.chain.nodes[0];
        });

        for (let rank = 0; rank < group.length; rank++) {
            const { idx, chain } = group[rank];
            if (!processed.has(idx)) {
                resolved.push({ ...chain, isHead: rank === 0 });
                processed.add(idx);
            }
        }
    }

    return resolved;
}
