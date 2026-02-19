/**
 * =============================================================================
 * BDRAM Scanner - List Detector
 *
 * Drives static and dynamic list detection using the shared walkChainsAtOffset
 * and resolveChainConflicts functions from chain-walker.js.
 *
 * Static detection
 * ----------------
 * Operates on the StaticStatic pool — addresses whose pointer value is
 * identical across every batch. The value is therefore batch-independent.
 * Ghost bridging is enabled because a node can be absent from the scan data
 * while still being part of the logical structure.
 * Detection runs once, not per-batch.
 *
 * Dynamic detection
 * -----------------
 * Operates on the StaticNode pool — addresses present in every batch but with
 * differing values. Each batch gets its own independent working set that shrinks
 * as nodes are consumed into structures. Ghost bridging is disabled; if a node
 * is absent from one batch's value map it simply isn't there.
 * Entry points are created when a chain walks into an existing target pool.
 *
 * Shared behaviour
 * ----------------
 * Both sweep offsets 0x0 → 0x3C in 4-byte steps, smallest first.
 * Both use the same resolveChainConflicts winner rule (longest, then smallest root).
 * Both write to scanner.structures, scanner.targetNodes, scanner.entryPoints.
 * =============================================================================
 */

'use strict';

const OFFSET_MIN    = 0x00;
const OFFSET_MAX    = 0x3C;
const OFFSET_STEP   =    4;

// ---------------------------------------------------------------------------
// Static list detection
// ---------------------------------------------------------------------------

/**
 * Detect static linked-list structures from the StaticStatic node pool.
 *
 * After detection, static structures are immediately converted to achievements
 * and cleared from memory. Remaining StaticStatic nodes are either discarded
 * (skipStickyPointers=true) or merged back into staticNodes for base-pointer
 * scanning (skipStickyPointers=false).
 *
 * @param {BDRAMScanner} sc  The scanner instance (source of state + config).
 */
function detectStaticLists(sc) {
    // The pool is the full set of StaticStatic addresses, sorted ascending
    // so head-node selection is deterministic.
    const pool    = new Set(
        Array.from(sc.staticStaticNodes.keys()).sort((a, b) => a - b)
    );
    const getVal  = addr => sc.staticStaticNodes.get(addr); // batch-independent
    let   structId = 1;

    console.log(`Detecting static lists from ${pool.size} StaticStatic nodes`);
    for (let offset = OFFSET_MIN; offset <= OFFSET_MAX; offset += OFFSET_STEP) {

        const { chains } = walkChainsAtOffset(pool, offset, getVal, {
            minChainLength: sc.minChainLength,
            maxGhostNodes:  sc.maxGhostNodes,
            targetPool:     null            // static detection never creates entry points
        });

        if (chains.length === 0) continue;

        const resolved = resolveChainConflicts(chains);

        for (const chain of resolved) {
            if (!chain.isHead) continue;
            if (chain.nodes.length < sc.minChainLength) continue;

            const ghosts = chain.ghosts || [];
            const stride = _dominantStride(chain.nodes);

            sc.structures.push({
                id:         structId++,
                type:       'static_list',
                root:       chain.nodes[0],
                nodeCount:  chain.nodes.length,
                validCount: chain.nodes.length,
                ghostCount: ghosts.length,
                stride,
                addresses:  chain.nodes,
                ghosts,
                static:     true,
                buildOffset: offset
            });

            // Consume all nodes (valid + ghosts) into every batch's target pool
            // and remove them from the StaticStatic pool so later offsets don't
            // re-detect the same nodes.
            const allNodes = [...chain.nodes, ...ghosts];
            for (let b = 0; b < sc.batches.length; b++) {
                for (const addr of allNodes) sc.targetNodes[b].add(addr);
            }
            for (const addr of allNodes) {
                pool.delete(addr);
                sc.staticStaticNodes.delete(addr);
            }
        }
    }

    const count = sc.structures.filter(s => s.type === 'static_list').length;
    console.log(`Detected ${count} static lists`);
    // -----------------------------------------------------------------------
    // Stream static achievements and clear them from memory immediately.
    // -----------------------------------------------------------------------
    if (sc.generator) {
        const staticStructures = sc.structures.filter(s => s.type === 'static_list');
        if (staticStructures.length > 0) {
            sc.staticStructureCount = staticStructures.length;
            const achievements = sc.generator.generateAchievements(staticStructures);
            sc.staticAchievementCount += achievements.length;
            sc.totalAchievementCount  += achievements.length;
            
            // Emit achievement count updates for global tracking
            globalEventBus.emit('achievement:update', { static: achievements.length, dynamic: 0 });
            
            for (const ach of achievements) {
                sc.staticOutput +=
                    `${ach.id || ''}:"${ach.logic}":${ach.title}:${ach.description}` +
                    `::::BigDonRob:0:::::00000\n`;
            }
            console.log(`Generated ${achievements.length} static achievements`);
            sc.structures = sc.structures.filter(s => s.type !== 'static_list');
        }
    }

    // -----------------------------------------------------------------------
    // Handle remaining StaticStatic nodes.
    // -----------------------------------------------------------------------
    if (sc.skipStickyPointers) {
        const n = sc.staticStaticNodes.size;
        sc.staticStaticNodes.clear();
        console.log(`Skipped ${n} sticky pointers (no value change across batches)`);    } else {
        // Promote remaining StaticStatics to StaticNodes so they become
        // base-pointer candidates. Each batch gets the same fixed value.
        let n = 0;
        for (const [addr, value] of sc.staticStaticNodes) {
            sc.staticNodes.set(addr, new Array(sc.batches.length).fill(value));
            n++;
        }
        sc.staticStaticNodes.clear();
        console.log(`Promoted ${n} StaticStatic nodes to StaticNodes for base-pointer scanning`);    }
}

// ---------------------------------------------------------------------------
// Dynamic list detection
// ---------------------------------------------------------------------------

/**
 * Detect dynamic linked-list structures from the StaticNode pool.
 *
 * Each batch maintains its own independent working set (batchNodes[b]) that
 * shrinks as nodes are consumed. Entry points are created when a chain reaches
 * an existing target node in that batch's pool.
 *
 * @param {BDRAMScanner} sc
 */
function detectDynamicLists(sc) {
    const B = sc.batches.length;

    // Build per-batch working sets: all StaticNodes not already in targetNodes[b].
    const batchNodes = [];
    for (let b = 0; b < B; b++) {
        const working = new Set();
        for (const addr of sc.staticNodes.keys()) {
            if (!sc.targetNodes[b].has(addr)) working.add(addr);
        }
        batchNodes.push(working);
    }

    for (let offset = OFFSET_MIN; offset <= OFFSET_MAX; offset += OFFSET_STEP) {

        for (let b = 0; b < B; b++) {
            const working = batchNodes[b];
            if (working.size === 0) continue;

            // Value accessor for this batch only.
            const getVal = addr => {
                const vals = sc.staticNodes.get(addr);
                return vals ? vals[b] : undefined;
            };

            const { chains, entryPoints } = walkChainsAtOffset(
                working, offset, getVal, {
                    minChainLength: sc.minChainLength,
                    maxGhostNodes:  0,              // no ghosts for dynamic
                    targetPool:     sc.targetNodes[b]
                }
            );

            // Resolve conflicts within this batch independently.
            const resolved = resolveChainConflicts(chains);

            for (const chain of resolved) {
                if (chain.isHead && chain.nodes.length >= sc.minChainLength) {
                    sc.structures.push({
                        id:          sc.structures.length,
                        type:        'dynamic_list',
                        root:        chain.nodes[0],
                        nodeCount:   chain.nodes.length,
                        stride:      offset,
                        addresses:   chain.nodes,
                        static:      false,
                        buildOffset: offset,
                        batchIdx:    b
                    });
                    for (const addr of chain.nodes) {
                        sc.targetNodes[b].add(addr);
                        working.delete(addr);
                    }
                } else if (!chain.isHead) {
                    // Losing chain — treat as entry point for further scanning.
                    for (const addr of chain.nodes) working.delete(addr);
                }
            }

            // Chains that reached a target pool become entry points.
            for (const ep of entryPoints) {
                sc.entryPoints.push({
                    root:        ep.nodes[0],
                    nodeCount:   ep.nodes.length,
                    addresses:   ep.nodes,
                    buildOffset: offset,
                    path:        [offset],
                    batchIdx:    b,
                    claimed:     false
                });
                for (const addr of ep.nodes) working.delete(addr);
            }
        }

        const remaining = batchNodes.map((s, i) => `batch${i}=${s.size}`).join(', ');
    }

    sc.dynamicStructureCount = sc.structures.filter(s => s.type === 'dynamic_list').length;
    sc.entryPointCount       = sc.entryPoints.length;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Return the most frequently occurring gap between consecutive node addresses.
 * Falls back to 4 for single-node chains.
 *
 * @param {number[]} nodes  Sorted array of addresses.
 * @returns {number}
 */
function _dominantStride(nodes) {
    if (nodes.length < 2) return 4;
    const freq = new Map();
    for (let i = 1; i < nodes.length; i++) {
        const d = nodes[i] - nodes[i - 1];
        freq.set(d, (freq.get(d) || 0) + 1);
    }
    let best = 4, bestCount = 0;
    for (const [d, n] of freq) {
        if (n > bestCount) { bestCount = n; best = d; }
    }
    return best;
}
