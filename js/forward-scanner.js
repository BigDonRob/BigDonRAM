/**
 * =============================================================================
 * BDRAM Scanner - Forward Scanner
 *
 * Everything that happens after list detection:
 *
 *   1. buildBasePointerSet(sc)
 *      Promote leftover StaticNodes (not already in any target pool) to the
 *      base-pointer Map, which is the entry-point set for DFS scanning.
 *
 *   2. buildBatchIndexes(sc)
 *      Build per-batch address→index Maps for O(1) value lookups during DFS.
 *      Called once; the result is passed explicitly to all scan functions.
 *
 *   3. buildTraversalBitmaps(sc, batchIndexes)
 *      Precompute offset presence bitmaps for every non-base-pointer node.
 *      Returns a bitmap context object consumed by scanBasePointerDepth().
 *
 *   4. scanAllBasePointers(sc, batchIndexes)
 *      Top-level async driver: iterates enabled ranges, streams achievements
 *      every 1 000 base pointers, handles early-out signals.
 *
 *   5. scanSingleBasePointer(sc, base, batchIndexes, lookups, bitmapCtx)
 *      Splits the offset space into 0x80-byte chunks and dispatches each to
 *      scanBasePointerDepth().
 *
 *   6. scanBasePointerDepth(sc, base, batchIndexes, chunk, lookups, bitmapCtx)
 *      Inner DFS loop: bitmap AND across batches → choose smallest valid
 *      offset → follow → repeat to maxDepth.
 *
 * Bitmap context shape (returned by buildTraversalBitmaps):
 * {
 *   store       : Map<addr, Int32Array>  layout: [b0s0, b0s1, …, b1s0, …]
 *   slots       : number                 Int32 slots per node per batch
 *   bytes       : number                 byte-offset coverage = slots * 128
 * }
 *
 * All functions receive explicit parameters — no implicit `this` coupling
 * to the scanner except through the `sc` argument where state must be read
 * or written.
 * =============================================================================
 */

'use strict';

// ---------------------------------------------------------------------------
// 1. Base pointer set construction
// ---------------------------------------------------------------------------

/**
 * Promote StaticNodes that haven't been consumed by list detection into the
 * base-pointer Map. A node that already appears in any batch's targetNodes
 * pool is already accounted for and is skipped.
 *
 * Populates sc.basePointers : Map<address, number[]>  (values per batch)
 *
 * @param {BDRAMScanner} sc
 * @param {Map[]}        batchIndexes  Pre-built address→index maps (see buildBatchIndexes).
 */
function buildBasePointerSet(sc, batchIndexes) {
    let added = 0;

    for (const addr of sc.staticNodes.keys()) {
        // Skip if already targeted in any batch.
        if (sc.targetNodes.some(pool => pool.has(addr))) continue;

        const values = [];
        let   valid  = true;

        for (let b = 0; b < sc.batches.length; b++) {
            const idx = batchIndexes[b].get(addr);
            if (idx === undefined) { valid = false; break; }
            values.push(sc.batches[b].values[idx]);
        }

        if (valid) {
            sc.basePointers.set(addr, values);
            added++;
        }
    }

    console.log(`Base pointer set: ${added} added, ${sc.basePointers.size} total`);
}

// ---------------------------------------------------------------------------
// 2. Batch index construction
// ---------------------------------------------------------------------------

/**
 * Build a per-batch Map from address → array index for O(1) value lookups.
 *
 * @param   {BDRAMScanner} sc
 * @returns {Map<number,number>[]}
 */
function buildBatchIndexes(sc) {
    return sc.batches.map(batch => {
        const idx = new Map();
        for (let i = 0; i < batch.addresses.length; i++) {
            idx.set(batch.addresses[i], i);
        }
        return idx;
    });
}

// ---------------------------------------------------------------------------
// 3. Traversal bitmap precomputation
// ---------------------------------------------------------------------------

/**
 * Precompute offset-presence bitmaps for all non-base-pointer nodes.
 *
 * These nodes are visited many times across base-pointer scans (depths 1+).
 * Precomputing their bitmaps once converts the inner DFS loop from
 * 32 × B Map lookups per step to B bitwise ANDs.
 *
 * Budget is fixed at 80 MB.  We compute how many Int32 slots per node that
 * allows and cover as many low offsets as the budget permits.
 *
 * Layout of each Int32Array (length = B × slots):
 *   [batch0_slot0, batch0_slot1, …, batch1_slot0, …]
 * Slot S covers offsets (S*128) … (S*128 + 124) bytes.
 * Bit N of slot S is set iff the node's value + (S*32+N)*4 is in batchIndexes[b].
 *
 * Nodes not in the store (base pointers, absent nodes) fall through to the
 * on-the-fly path in scanBasePointerDepth — no special flag needed.
 *
 * @param   {BDRAMScanner}       sc
 * @param   {Map<number,number>[]} batchIndexes
 * @returns {{ store: Map, slots: number, bytes: number }}
 */
function buildTraversalBitmaps(sc, batchIndexes) {
    const B          = sc.batches.length;
    const bpSet      = new Set(sc.basePointers.keys());
    const BUDGET_INT = (80 * 1024 * 1024) / 4;      // budget in Int32 units
    const maxBreadth = (parseInt(sc.maxBreadth, 16) & 0xFFFFFC);
    const totalSlots = Math.ceil(maxBreadth / 128);  // slots needed for full coverage

    // Collect traversal nodes from the union of all batch indexes, excluding
    // base pointers (which are only ever depth-0 start points).
    const traversalAddrs = new Set();
    for (let b = 0; b < B; b++) {
        for (const addr of batchIndexes[b].keys()) {
            if (!bpSet.has(addr)) traversalAddrs.add(addr);
        }
    }
    const N = traversalAddrs.size;

    if (N === 0) {
        console.log('Bitmap precompute: no traversal nodes — skipping');
        return { store: null, slots: 0, bytes: 0 };
    }

    const slotsPerNode = Math.max(1, Math.floor(BUDGET_INT / (N * B)));
    const usedSlots    = Math.min(slotsPerNode, totalSlots);
    const precompBytes = usedSlots * 128;

    const actualMB = ((N * B * usedSlots * 4) / 1024 / 1024).toFixed(1);
    console.log(
        `Bitmap precompute: ${N} traversal nodes × ${B} batches × ${usedSlots} slots = ` +
        `${actualMB} MB, covering 0x000–0x${(precompBytes - 4).toString(16).toUpperCase()} ` +
        `of 0x${maxBreadth.toString(16).toUpperCase()} ` +
        `(${sc.basePointers.size} base pointers excluded)`
    );

    const store = new Map();

    for (const addr of traversalAddrs) {
        const bm = new Int32Array(B * usedSlots);   // zero-initialised

        for (let b = 0; b < B; b++) {
            const dataIdx = batchIndexes[b].get(addr);
            if (dataIdx === undefined) continue;    // node absent in this batch

            const value   = sc.batches[b].values[dataIdx];
            const bOffset = b * usedSlots;

            for (let s = 0; s < usedSlots; s++) {
                let word = 0;
                for (let bit = 0; bit < 32; bit++) {
                    if (batchIndexes[b].has(value + (s * 32 + bit) * 4)) {
                        word |= (1 << bit);
                    }
                }
                bm[bOffset + s] = word;
            }
        }

        store.set(addr, bm);
    }

    return { store, slots: usedSlots, bytes: precompBytes };
}

// ---------------------------------------------------------------------------
// 4. Top-level scan driver
// ---------------------------------------------------------------------------

/**
 * Scan all base pointers across enabled ranges, streaming achievements
 * every 1 000 base pointers.
 *
 * Reads sc.enabledRanges (Set<number>) to filter which base pointers to visit.
 * Early-out signals bubble up from scanSingleBasePointer.
 *
 * @param {BDRAMScanner}        sc
 * @param {Map<number,number>[]} batchIndexes
 * @param {{ store, slots, bytes }} bitmapCtx
 */
async function scanAllBasePointers(sc, batchIndexes, bitmapCtx) {
    const total = sc.basePointers.size;

    // Build O(1) lookup caches for detection-phase structures and entry points.
    // Scan-phase entry points are NOT pre-cached; they are never target nodes.
    const structAddrMap = _buildStructAddrMap(sc);
    const epAddrMap     = _buildEpAddrMap(sc);

    const lookups = { structAddrMap, epAddrMap };

    let processed = 0;

    for (const [address, values] of sc.basePointers) {

        // Range gate: skip base pointers outside enabled ranges.
        if (!sc.isInScanRange(address)) {
            sc.basePointers.delete(address);
            continue;
        }

        const base   = { address, values };
        const result = await scanSingleBasePointer(sc, base, batchIndexes, lookups, bitmapCtx);

        sc.basePointers.delete(address);  // free as we go

        // Register new entry points (scan-phase).
        for (const hitStruct of result.structures) {
            sc.entryPoints.push({
                root:        base.values[0],
                nodeCount:   hitStruct.nodeCount,
                addresses:   hitStruct.addresses,
                buildOffset: hitStruct.buildOffset,
                path:        hitStruct.path || [],
                targetStruct: hitStruct,
                type:        'entry_point',
                sourceType:  hitStruct.type,
                claimed:     false
            });
        }
        for (const hitEP of result.entryPoints) {
            sc.entryPoints.push({
                root:        base.values[0],
                nodeCount:   hitEP.nodeCount,
                addresses:   hitEP.addresses,
                buildOffset: hitEP.buildOffset,
                path:        [...(hitEP.path || []), ...(hitEP.buildOffset ? [hitEP.buildOffset] : [])],
                targetStruct: hitEP.targetStruct,
                type:        'entry_point',
                claimed:     false
            });
        }

        processed++;

        // UI progress update every 100.
        if (processed % 100 === 0) {
            const pct = Math.floor((processed / total) * 25);
            globalEventBus.emit('progress:update', {
                percent: 60 + pct,
                status:  `Scanning base pointers: ${processed}/${total}`
            });
            await new Promise(r => setTimeout(r, 0));  // yield to event loop
        }

        // Stream achievements every 1 000 to control memory.
        if (processed % 1000 === 0) {
            sc.streamAchievements();
            sc.logMemoryStats(`BP ${processed}`);
        }

        if (result.stopAllProcessing) break;
    }

    console.log(`Forward scan complete: ${processed} base pointers scanned`);
}

// ---------------------------------------------------------------------------
// 5. Single base pointer — chunk dispatcher
// ---------------------------------------------------------------------------

/**
 * Scan one base pointer by splitting the offset space into 0x80-byte chunks
 * and dispatching each to the DFS inner loop.
 *
 * @param   {BDRAMScanner}        sc
 * @param   {{ address, values }} base
 * @param   {Map[]}               batchIndexes
 * @param   {{ structAddrMap, epAddrMap }} lookups
 * @param   {{ store, slots, bytes }}      bitmapCtx
 * @returns {Promise<{ structures, entryPoints, targetPaths, stopAllProcessing }>}
 */
async function scanSingleBasePointer(sc, base, batchIndexes, lookups, bitmapCtx) {
    const maxBreadth = (parseInt(sc.maxBreadth, 16) & 0xFFFFFC);
    const chunkSize  = 0x80;

    const all = { structures: [], entryPoints: [], targetPaths: [] };

    for (let start = 0x0; start <= maxBreadth; start += chunkSize) {
        const end    = Math.min(start + 0x7C, maxBreadth);
        const chunk  = { start, end };
        const result = await scanBasePointerDepth(sc, base, batchIndexes, chunk, lookups, bitmapCtx);

        all.structures.push(...result.structures);
        all.entryPoints.push(...result.entryPoints);
        all.targetPaths.push(...result.targetPaths);

        if (end >= maxBreadth) break;
    }

    if (all.structures.length === 0 && all.entryPoints.length === 0) {
        return { structures: [], entryPoints: [], targetPaths: [], stopAllProcessing: false };
    }

    // Early-out: if target paths were found and the flag is set, signal stop.
    const stopAll = sc.earlyOutTarget && all.targetPaths.length > 0;
    if (stopAll) {
        console.log('=== EARLY OUT: target addresses found, stopping all processing ===');
    }

    for (const ep of all.entryPoints) ep.claimed = true;

    return { ...all, stopAllProcessing: stopAll };
}

// ---------------------------------------------------------------------------
// 6. DFS inner loop — one chunk
// ---------------------------------------------------------------------------

/**
 * Depth-first scan of one base pointer for one 0x80-byte offset chunk.
 *
 * Bitmap fast path: if the current node has a precomputed bitmap AND the
 * chunk falls within precomputed coverage, AND the batch bitmaps together
 * directly — no per-offset Map lookups.
 *
 * On-the-fly fallback: any node not in the bitmap store (base pointers,
 * StaticStatics, nodes missing from batch indexes) recomputes per-offset.
 *
 * @param   {BDRAMScanner}  sc
 * @param   {{ address, values }} base
 * @param   {Map[]}         batchIndexes
 * @param   {{ start, end }} chunk
 * @param   {{ structAddrMap, epAddrMap }} lookups
 * @param   {{ store, slots, bytes }}      bitmapCtx
 * @returns {Promise<{ structures, entryPoints, targetPaths }>}
 */
async function scanBasePointerDepth(sc, base, batchIndexes, chunk, lookups, bitmapCtx) {
    const { start: chunkStart, end: chunkEnd } = chunk;
    const { structAddrMap, epAddrMap }         = lookups;
    const { store, slots: precompSlots, bytes: precompBytes } = bitmapCtx;

    const maxDepth   = sc.maxDepth;
    const batchCount = sc.batches.length;

    const hitStructures  = [];
    const hitEntryPoints = [];
    const targetPaths    = [];

    // Initial state: each batch starts at the value stored in the base pointer.
    let state = {
        addresses: base.values.map((val, idx) => ({ addr: val, batchIdx: idx })),
        depth:     1,
        path:      []
    };

    while (state.depth <= maxDepth) {

        // Yield to event loop every 3 depths to avoid blocking.
        if (state.depth % 3 === 0) {
            await new Promise(r => setTimeout(r, 0));
        }

        const firstAddr = state.addresses[0].addr;

        // --- Injected target check -------------------------------------------
        if (sc.injectedTargets.has(firstAddr)) {
            if (state.addresses.every(({ addr }) => sc.injectedTargets.has(addr))) {
                const pathStr = state.path
                    .map((o, i) => `${'+'.repeat(i + 1)}0x${o.toString(16).toUpperCase()}`)
                    .join(' ');
                targetPaths.push({
                    basePointer:   `0x${base.address.toString(16).toUpperCase()}`,
                    path:          pathStr,
                    targetAddress: `0x${firstAddr.toString(16).toUpperCase()}`
                });
                break;
            }
        }

        // --- Structure / entry-point hit check -------------------------------
        const hits = state.addresses.map(({ addr }) =>
            structAddrMap.get(addr) || epAddrMap.get(addr) || null
        );
        const validHits = hits.filter(Boolean);

        if (validHits.length === batchCount) {
            const first   = validHits[0];
            const allSame = validHits.every(h => h.type === first.type && h.id === first.id);
            if (allSame) {
                if (first.type === 'structure') {
                    hitStructures.push({ ...first.struct, depth: state.depth, path: state.path, movingEntryPoint: true });
                } else {
                    hitEntryPoints.push({ ...first.ep, depth: state.depth, path: state.path, movingEntryPoint: true });
                }
                break;
            }
        }

        // --- Build combined bitmap for this chunk ----------------------------
        let combinedBitmap;

        const precomp  = store && store.get(firstAddr);
        const slotIdx  = Math.floor(chunkStart / 128);
        const usePrecomp = precomp && chunkStart < precompBytes && slotIdx < precompSlots;

        if (usePrecomp) {
            // Fast path: AND the pre-built slots together.
            combinedBitmap = 0xFFFFFFFF;
            for (let b = 0; b < batchCount; b++) {
                combinedBitmap &= precomp[b * precompSlots + slotIdx];
            }
        } else {
            // On-the-fly path: check each offset in the chunk per batch.
            const batchBitmaps = [];
            for (let b = 0; b < batchCount; b++) {
                const { addr } = state.addresses[b];
                const dataIdx  = batchIndexes[b].get(addr);

                if (dataIdx === undefined) {
                    batchBitmaps.push(0);
                    continue;
                }

                const value = sc.batches[b].values[dataIdx];
                let   word  = 0;
                for (let bit = 0; bit < 32; bit++) {
                    const targetAddr = value + chunkStart + bit * 4;
                    if (batchIndexes[b].has(targetAddr)) word |= (1 << bit);
                }
                batchBitmaps.push(word);
            }

            combinedBitmap = 0xFFFFFFFF;
            for (const w of batchBitmaps) combinedBitmap &= w;
        }

        if (combinedBitmap === 0) break;  // no shared valid offset in this chunk

        // Pick the smallest valid offset in this chunk.
        let chosenOffset = null;
        for (let bit = 0; bit < 32; bit++) {
            if ((combinedBitmap & (1 << bit)) !== 0) {
                const candidate = chunkStart + bit * 4;
                if (candidate <= chunkEnd) { chosenOffset = candidate; break; }
            }
        }
        if (chosenOffset === null) break;

        // --- Majority voting for entry-point early exit ----------------------
        let targetCount = 0;
        const buildOffsetFreq = new Map();

        for (let b = 0; b < batchCount; b++) {
            const { addr }  = state.addresses[b];
            const dataIdx   = batchIndexes[b].get(addr);
            if (dataIdx === undefined) continue;

            const value      = sc.batches[b].values[dataIdx];
            const targetAddr = value + chosenOffset;

            if (sc.targetNodes[b].has(targetAddr)) {
                targetCount++;
                continue;
            }

            // Check detection-phase entry points for this batch.
            for (const ep of sc.entryPoints) {
                if (ep.batchIdx === b && ep.addresses.includes(targetAddr)) {
                    targetCount++;
                    buildOffsetFreq.set(ep.buildOffset, (buildOffsetFreq.get(ep.buildOffset) || 0) + 1);
                    break;
                }
            }
        }

        const hasMajority = targetCount > batchCount * 0.66;
        let   offsetsAgree = true;
        if (buildOffsetFreq.size > 0) {
            const epTotal   = [...buildOffsetFreq.values()].reduce((a, b) => a + b, 0);
            const epBest    = Math.max(...buildOffsetFreq.values());
            offsetsAgree    = epBest > epTotal * 0.5;
        }

        if (hasMajority && offsetsAgree) {
            // Find winning buildOffset.
            let winningOffset = chosenOffset;
            let winningCount  = 0;
            for (const [o, c] of buildOffsetFreq) {
                if (c > winningCount) { winningCount = c; winningOffset = o; }
            }
            hitEntryPoints.push({
                root:        base.address,
                nodeCount:   state.depth,
                addresses:   [state.addresses[0].addr],
                buildOffset: winningOffset,
                path:        [...state.path, chosenOffset],
                claimed:     false
            });
            break;
        }

        // --- Advance state ---------------------------------------------------
        const nextAddrs = [];
        for (let b = 0; b < batchCount; b++) {
            const { addr }  = state.addresses[b];
            const dataIdx   = batchIndexes[b].get(addr);
            if (dataIdx === undefined) {
                nextAddrs.push({ addr: 0, batchIdx: b });
                continue;
            }
            const value    = sc.batches[b].values[dataIdx];
            nextAddrs.push({ addr: value + chosenOffset, batchIdx: b });
        }

        state = {
            addresses: nextAddrs,
            depth:     state.depth + 1,
            path:      [...state.path, chosenOffset]
        };
    }

    return { structures: hitStructures, entryPoints: hitEntryPoints, targetPaths };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _buildStructAddrMap(sc) {
    const m = new Map();
    for (const struct of sc.structures) {
        const entry = { type: 'structure', id: struct.id, struct };
        for (const addr of (struct.addresses || [])) m.set(addr, entry);
        for (const addr of (struct.ghosts    || [])) m.set(addr, entry);
    }
    return m;
}

function _buildEpAddrMap(sc) {
    const m = new Map();
    for (const ep of sc.entryPoints) {
        const entry = { type: 'entry_point', id: ep.root, ep };
        for (const addr of (ep.addresses || [])) m.set(addr, entry);
    }
    return m;
}
