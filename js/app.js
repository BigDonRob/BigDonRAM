/**
 * =============================================================================
 * BDRAM Scanner - Bitmap Intersection Structure Detection
 * =============================================================================
 *
 * Consumes collapsed preprocessor output:
 *   { systemId, batchCount, staticStatics, staticNodes, dynamicNodes }
 *
 * Reconstructs per-batch address/value arrays for bitmap operations,
 * then uses the pre-classified pools directly for structure detection.
 * =============================================================================
 */

class BDRAMScanner {

    constructor() {
        // Per-batch arrays reconstructed from preprocessor output at scan time
        this.batches    = [];
        this.structures = [];
        this.systemId   = 'n64';
        this.systemConfig = null;

        // Classified pools populated by _ingestPreprocessorOutput()
        this.staticStatics = null;  // { addresses: Int32Array, values: Int32Array }
        this.staticNodes   = null;  // { addresses: Int32Array, values: Int32Array[] }
        this.dynamicNodes  = null;  // { addresses: Int32Array, values: Int32Array[] }

        // Scan parameters — set by UI controller before calling processBatches()
        this.maxBreadth          = '0xFFC';
        this.maxDepth            = 12;
        this.earlyOutBasePointer = true;
        this.earlyOutTarget      = true;
        this.skipStickyPointers  = true;
        this.enabledRanges       = [0];     // range indices (0-based) to include
        this.generator           = null;

        this.minChainLength = 5;
        this.maxOffset      = 16383; // 0xFFFF / 4
    }

    // =========================================================================
    // Main entry point
    // =========================================================================

    /**
     * Run the full scanning pipeline on collapsed preprocessor output.
     *
     * @param {Object} preprocessorOutput — result of Preprocessor.collapse()
     * @param {number[]} targetAddresses  — optional addresses to path-find
     * @returns {Object} result summary
     */
    async processBatches(preprocessorOutput, targetAddresses = []) {
        const startTime   = Date.now();
        this.systemId     = preprocessorOutput.systemId;
        this.systemConfig = Config.getSystemConfig(this.systemId);
        this.structures   = [];

        this._ingestPreprocessorOutput(preprocessorOutput);

        try {
            globalEventBus.emit('stage:update', { stage: 'parse',    status: 'completed' });
            globalEventBus.emit('stage:update', { stage: 'detect',   status: 'active' });
            globalEventBus.emit('progress:update', { percent: 20, status: 'Removing VTable anchors...' });

            this.removeVTableAnchors();

            globalEventBus.emit('progress:update', { percent: 35, status: 'Detecting static structures...' });
            this.detectStaticStructures();

            globalEventBus.emit('stage:update', { stage: 'detect', status: 'completed' });
            globalEventBus.emit('stage:update', { stage: 'scan',   status: 'active' });
            globalEventBus.emit('progress:update', { percent: 55, status: 'Detecting dynamic structures...' });

            await this.detectDynamicStructures();

            globalEventBus.emit('stage:update', { stage: 'scan', status: 'completed' });

            if (targetAddresses.length > 0) {
                globalEventBus.emit('stage:update', { stage: 'validate', status: 'active' });
                globalEventBus.emit('progress:update', { percent: 80, status: 'Scanning to target addresses...' });
                await this._scanToTargets(targetAddresses);
                globalEventBus.emit('stage:update', { stage: 'validate', status: 'completed' });
            } else {
                globalEventBus.emit('stage:update', { stage: 'validate', status: 'skipped' });
            }

            globalEventBus.emit('stage:update', { stage: 'generate', status: 'active' });
            globalEventBus.emit('progress:update', { percent: 95, status: 'Finalizing structures...' });
            this.finalizeStructures();

            return {
                batchCount:     this.batches.length,
                structureCount: this.structures.length,
                processingTime: ((Date.now() - startTime) / 1000).toFixed(1),
                structures:     this.structures
            };

        } catch (error) {
            console.error('Scanner error:', error);
            throw error;
        }
    }

    // =========================================================================
    // Preprocessor intake
    // =========================================================================

    /**
     * Ingest collapsed preprocessor output.
     *
     * Stores the three classified pools, then reconstructs per-batch arrays
     * so that existing bitmap operations work without modification.
     * Each batch receives every address whose slot value for that batch is non-zero.
     */
    _ingestPreprocessorOutput(output) {
        this.staticStatics = output.staticStatics;
        this.staticNodes   = output.staticNodes;
        this.dynamicNodes  = output.dynamicNodes;

        const n = output.batchCount;
        this.batches = Array.from({ length: n }, () => ({ addresses: [], values: [] }));

        // StaticStatics: same value in every batch
        const { addresses: ssA, values: ssV } = output.staticStatics;
        for (let i = 0; i < ssA.length; i++) {
            for (let b = 0; b < n; b++) {
                this.batches[b].addresses.push(ssA[i]);
                this.batches[b].values.push(ssV[i]);
            }
        }

        // StaticNodes: per-batch value array
        const { addresses: snA, values: snV } = output.staticNodes;
        for (let i = 0; i < snA.length; i++) {
            for (let b = 0; b < n; b++) {
                if (snV[i][b] !== 0) {
                    this.batches[b].addresses.push(snA[i]);
                    this.batches[b].values.push(snV[i][b]);
                }
            }
        }

        // DynamicNodes: per-batch, zero means absent
        const { addresses: dynA, values: dynV } = output.dynamicNodes;
        for (let i = 0; i < dynA.length; i++) {
            for (let b = 0; b < n; b++) {
                if (dynV[i][b] !== 0) {
                    this.batches[b].addresses.push(dynA[i]);
                    this.batches[b].values.push(dynV[i][b]);
                }
            }
        }

        for (let b = 0; b < n; b++) {
            console.log(`Batch ${b}: ${this.batches[b].addresses.length} nodes`);
        }
    }

    // =========================================================================
    // VTable anchor removal
    // =========================================================================

    /**
     * Remove values appearing more than 10 times in any batch.
     * VTable pointers generate noise in the bitmap scan.
     */
    removeVTableAnchors() {
        for (const batch of this.batches) {
            const counts = new Map();
            for (const v of batch.values) counts.set(v, (counts.get(v) || 0) + 1);

            const vtable = new Set();
            for (const [v, c] of counts) if (c > 10) vtable.add(v);

            const kA = [], kV = [];
            for (let i = 0; i < batch.addresses.length; i++) {
                if (!vtable.has(batch.values[i])) {
                    kA.push(batch.addresses[i]);
                    kV.push(batch.values[i]);
                }
            }

            const removed = batch.addresses.length - kA.length;
            batch.addresses = kA;
            batch.values    = kV;
            if (removed > 0) console.log(`VTable removal: ${removed} nodes removed`);
        }
    }

    // =========================================================================
    // Static structure detection
    // =========================================================================

    /**
     * Detect static structures from the staticStatics pool.
     * StaticStatics have the same address AND value across all batches —
     * they contain both genuine static structures and base pointers that didn't move.
     */
    detectStaticStructures() {
        const { addresses, values } = this.staticStatics;
        if (addresses.length === 0) {
            console.log('No StaticStatics — skipping static structure detection');
            return;
        }

        const staticMap = new Map();
        const addrSet   = new Set();
        for (let i = 0; i < addresses.length; i++) {
            staticMap.set(addresses[i], values[i]);
            addrSet.add(addresses[i]);
        }

        const offsetBitmaps = this.buildStaticOffsetBitmaps(staticMap, addrSet);
        const visited = new Set();

        for (const [addr, bitmap] of offsetBitmaps) {
            if (visited.has(addr) || bitmap === 0) continue;

            for (let bitIdx = 0; bitIdx < Math.min(this.maxOffset, 31); bitIdx++) {
                if ((bitmap & (1 << bitIdx)) === 0) continue;

                const chain = this.followStaticChain(
                    addr, bitIdx * 4, staticMap, visited
                );

                if (chain.length >= this.minChainLength) {
                    const stride = this.calculateChainStride(chain);
                    this.structures.push({
                        id:                this.structures.length,
                        type:              'list',
                        root:              chain[0],
                        nodeCount:         chain.length,
                        stride:            stride.dominant,
                        strideConsistency: stride.consistency,
                        addresses:         chain,
                        static:            true,
                        ordered:           stride.consistency > 0.9,
                        batchesSeen:       (1 << this.batches.length) - 1
                    });
                }
            }
        }

        console.log(`Static structures detected: ${this.structures.length}`);
    }

    buildStaticOffsetBitmaps(staticMap, addrSet) {
        const bitmaps = new Map();
        for (const [addr, value] of staticMap) {
            let bitmap = 0;
            for (let i = 0; i < Math.min(this.maxOffset, 31); i++) {
                if (addrSet.has(value + i * 4)) bitmap |= (1 << i);
            }
            bitmaps.set(addr, bitmap);
        }
        return bitmaps;
    }

    followStaticChain(startAddr, offset, staticMap, visited) {
        const chain = [startAddr];
        visited.add(startAddr);
        let cur = startAddr;

        while (chain.length < 1000) {
            const value = staticMap.get(cur);
            if (value === undefined) break;
            const next = value + offset;
            if (!staticMap.has(next) || visited.has(next)) break;
            chain.push(next);
            visited.add(next);
            cur = next;
        }

        return chain;
    }

    calculateChainStride(chain) {
        if (chain.length < 2) return { dominant: 0, consistency: 0 };
        const strides = new Map();
        for (let i = 0; i < chain.length - 1; i++) {
            const s = chain[i + 1] - chain[i];
            strides.set(s, (strides.get(s) || 0) + 1);
        }
        let maxCount = 0, dominant = 0;
        for (const [s, c] of strides) {
            if (c > maxCount) { maxCount = c; dominant = s; }
        }
        return { dominant, consistency: maxCount / (chain.length - 1) };
    }

    // =========================================================================
    // Dynamic structure detection
    // =========================================================================

    /**
     * Detect dynamic structures using staticNodes as base pointers.
     * StaticNodes have the same address in all batches but differing values —
     * the highest-probability base pointers.
     */
    async detectDynamicStructures() {
        this.detectDynamicLists();

        const dynamicBases = this._buildDynamicBases();
        console.log(`Dynamic base pointers: ${dynamicBases.length}`);
        if (dynamicBases.length === 0) return;

        const batchIndexes = this._buildBatchIndexes();
        const targets      = this.collectAllTargetNodes();
        console.log(`Target nodes collected: ${targets.size}`);

        const foundStructures = new Set();
        const maxOffset = CoreUtils.parseHex(this.maxBreadth) || 0xFFC;
        const chunkSize = 0x100;

        let totalPaths = 0;
        let baseIndex  = 0;

        for (let chunkStart = 0; chunkStart < maxOffset; chunkStart += chunkSize) {
            const chunkEnd = Math.min(chunkStart + chunkSize, maxOffset);

            for (const base of dynamicBases) {
                baseIndex++;

                if (baseIndex % 100 === 0) {
                    globalEventBus.emit('progress:update', {
                        percent: 55 + Math.floor((baseIndex / dynamicBases.length) * 30),
                        status:  `Dynamic scan: ${baseIndex}/${dynamicBases.length} bases...`
                    });
                }

                const paths = this.forwardScanChunk(
                    base, batchIndexes, targets,
                    chunkStart, chunkEnd,
                    foundStructures, []
                );

                if (paths.length > 0) {
                    totalPaths += paths.length;
                    this.structures.push({
                        id:                this.structures.length,
                        type:              'list',
                        root:              paths[0].targetAddress,
                        nodeCount:         paths[0].structureSize || 1,
                        stride:            paths[0].stride || 0,
                        strideConsistency: 1.0,
                        static:            false,
                        ordered:           true,
                        batchesSeen:       (1 << this.batches.length) - 1,
                        entryPoints:       paths.map(p => ({
                            sourceAddress: base.address,
                            offsetPath:    p.fullPath,
                            pathLength:    p.fullPath.length,
                            batchesSeen:   (1 << this.batches.length) - 1
                        }))
                    });
                }

                if (baseIndex % 50 === 0) await CoreUtils.delay(0);
            }

            if (chunkStart === 0 && foundStructures.size > targets.size * 0.7) {
                console.log(`Early exit: ${foundStructures.size}/${targets.size} structures found (≥70%)`);
                break;
            }

            baseIndex = 0;
        }

        console.log(`Dynamic scan: ${totalPaths} paths, ${this.structures.length} total structures`);
    }

    _buildDynamicBases() {
        const { addresses, values } = this.staticNodes;
        const bases = [];
        for (let i = 0; i < addresses.length; i++) {
            bases.push({ address: addresses[i], values: Array.from(values[i]) });
        }
        return bases;
    }

    _buildBatchIndexes() {
        return this.batches.map(batch => {
            const idx = new Map();
            for (let i = 0; i < batch.addresses.length; i++) idx.set(batch.addresses[i], i);
            return idx;
        });
    }

    // =========================================================================
    // Target address path-finding
    // =========================================================================

    async _scanToTargets(targetAddresses) {
        const dynamicBases = this._buildDynamicBases();
        if (dynamicBases.length === 0) return;

        const batchIndexes = this._buildBatchIndexes();
        const targets      = new Set(targetAddresses);
        let pathsFound     = 0;

        for (let i = 0; i < dynamicBases.length; i++) {
            const paths = this.deepScanToTargets(dynamicBases[i], targets, batchIndexes);
            if (paths.length > 0) {
                pathsFound += paths.length;
                for (const path of paths) {
                    this.structures.push({
                        id:                this.structures.length,
                        type:              'target',
                        root:              path.targetAddress,
                        nodeCount:         1,
                        stride:            0,
                        strideConsistency: 1.0,
                        static:            false,
                        ordered:           false,
                        batchesSeen:       (1 << this.batches.length) - 1,
                        entryPoints:       [{
                            sourceAddress: dynamicBases[i].address,
                            offsetPath:    path.fullPath,
                            pathLength:    path.fullPath.length,
                            batchesSeen:   (1 << this.batches.length) - 1
                        }]
                    });
                }
            }
            if (i % 50 === 0) await CoreUtils.delay(0);
        }

        console.log(`Target scan: ${pathsFound} paths to ${targets.size} targets`);
    }

    deepScanToTargets(base, targets, batchIndexes) {
        const maxDepth          = this.maxDepth;
        const maxStatesPerDepth = 100;
        const validPaths        = [];
        const maxPaths          = 20;
        const fullRange         = CoreUtils.parseHex(this.maxBreadth) || 0xFFC;

        let currentLevel = [{
            depth:     0,
            addresses: base.values.map((val, idx) => ({ batchIdx: idx, addr: val })),
            path:      []
        }];

        for (let depth = 1; depth <= maxDepth; depth++) {
            const nextLevel = [];
            for (const state of currentLevel) {
                const bitmaps = state.addresses.map(curr =>
                    this.buildChunkBitmap(curr.addr, curr.batchIdx, batchIndexes[curr.batchIdx], 0, fullRange)
                );
                const common = this.andBitmaps(bitmaps);

                this.iterateOffsets(common, (offset) => {
                    const nextAddrs = [];
                    let allValid    = true;

                    for (const curr of state.addresses) {
                        const idx = batchIndexes[curr.batchIdx].get(curr.addr);
                        if (idx === undefined) { allValid = false; break; }
                        const nextAddr = this.batches[curr.batchIdx].values[idx] + offset;
                        if (!batchIndexes[curr.batchIdx].has(nextAddr)) { allValid = false; break; }
                        nextAddrs.push({ batchIdx: curr.batchIdx, addr: nextAddr });
                    }

                    if (!allValid) return;

                    if (targets.has(nextAddrs[0].addr) && nextAddrs.every(na => targets.has(na.addr))) {
                        validPaths.push({ fullPath: [...state.path, offset], targetAddress: nextAddrs[0].addr });
                        return;
                    }
                    if (nextLevel.length < maxStatesPerDepth) {
                        nextLevel.push({ depth, addresses: nextAddrs, path: [...state.path, offset] });
                    }
                });

                if (validPaths.length >= maxPaths) return validPaths;
            }

            currentLevel = nextLevel;
            if (currentLevel.length === 0) break;
        }

        return validPaths;
    }

    // =========================================================================
    // Dynamic list detection (leftover nodes not in static structures)
    // =========================================================================

    detectDynamicLists() {
        const staticAddrs  = new Set();
        for (const s of this.structures) {
            if (s.static && s.addresses) s.addresses.forEach(a => staticAddrs.add(a));
        }

        const batchIndexes = this._buildBatchIndexes();
        const leftover     = this.findLeftoverNodes(staticAddrs, batchIndexes);
        console.log(`Leftover nodes for dynamic list detection: ${leftover.length}`);

        for (const node of leftover) {
            const structure = this.detectStructureFromNode(node, batchIndexes);
            if (structure && structure.nodeCount >= 5) {
                this.structures.push({
                    id:                this.structures.length,
                    type:              structure.type,
                    root:              node,
                    nodeCount:         structure.nodeCount,
                    stride:            structure.stride,
                    strideConsistency: 1.0,
                    addresses:         structure.addresses,
                    static:            false,
                    ordered:           true,
                    batchesSeen:       (1 << this.batches.length) - 1
                });
            }
        }
    }

    findLeftoverNodes(staticAddrs, batchIndexes) {
        const counts = new Map();
        for (let b = 0; b < this.batches.length; b++) {
            for (const addr of this.batches[b].addresses) {
                if (!staticAddrs.has(addr)) counts.set(addr, (counts.get(addr) || 0) + 1);
            }
        }
        const result = [];
        for (const [addr, c] of counts) if (c === this.batches.length) result.push(addr);
        return result;
    }

    detectStructureFromNode(startAddr, batchIndexes) {
        const offsetSequences = [];
        for (let b = 0; b < this.batches.length; b++) {
            const seq = this.followChain(startAddr, b, batchIndexes[b], 0xFC);
            if (seq.length < 4) return null;
            offsetSequences.push(seq);
        }

        const first    = offsetSequences[0];
        const allMatch = offsetSequences.every(s => s.pattern === first.pattern);
        if (!allMatch) return null;

        const avgCount = Math.round(
            offsetSequences.reduce((s, o) => s + o.nodeCount, 0) / offsetSequences.length
        );

        if (first.type === 'list') {
            return { type: 'list', nodeCount: avgCount, stride: first.offset, addresses: first.addresses };
        }
        if (first.type === 'tree') {
            return { type: 'tree', nodeCount: avgCount, stride: first.offsets[0], addresses: first.addresses };
        }
        return null;
    }

    followChain(startAddr, batchIdx, addrIndex, maxRange) {
        const batch          = this.batches[batchIdx];
        const visited        = new Set();
        let cur              = startAddr;
        const offsetSequence = [];
        const addresses      = [startAddr];

        for (let depth = 0; depth < 20; depth++) {
            if (visited.has(cur)) break;
            visited.add(cur);

            const idx = addrIndex.get(cur);
            if (idx === undefined) break;

            const val          = batch.values[idx];
            const validOffsets = [];
            for (let offset = 0; offset <= maxRange; offset += 4) {
                const target = val + offset;
                if (addrIndex.has(target) && !visited.has(target)) validOffsets.push(offset);
            }

            if (validOffsets.length === 0) break;
            offsetSequence.push(validOffsets);

            if (validOffsets.length === 1) {
                cur = val + validOffsets[0];
                addresses.push(cur);
            } else break;
        }

        if (offsetSequence.length < 4) return { length: offsetSequence.length };

        if (offsetSequence[0].length === 1) {
            const offset = offsetSequence[0][0];
            let repeats  = 1;
            for (let i = 1; i < offsetSequence.length; i++) {
                if (offsetSequence[i].length === 1 && offsetSequence[i][0] === offset) repeats++;
                else break;
            }
            if (repeats >= 4) {
                return {
                    length: offsetSequence.length, type: 'list',
                    pattern: String(offset), offset, nodeCount: repeats,
                    addresses: addresses.slice(0, repeats)
                };
            }
        }

        if (offsetSequence[0].length >= 2) {
            const pattern = offsetSequence[0].slice().sort().join(',');
            let repeats   = 1;
            for (let i = 1; i < offsetSequence.length; i++) {
                if (offsetSequence[i].slice().sort().join(',') === pattern) repeats++;
                else break;
            }
            if (repeats >= 4) {
                return {
                    length: offsetSequence.length, type: 'tree',
                    pattern, offsets: offsetSequence[0], nodeCount: repeats,
                    addresses: addresses.slice(0, repeats)
                };
            }
        }

        return { length: offsetSequence.length };
    }

    // =========================================================================
    // Forward scan chunk — shared by dynamic detection and target scan
    // =========================================================================

    forwardScanChunk(base, batchIndexes, targets, chunkStart, chunkEnd, foundStructures, discoveredTargets) {
        const maxDepth          = this.maxDepth;
        const maxStatesPerDepth = 100;
        const validPaths        = [];

        let currentLevel = [{
            depth:     0,
            addresses: base.values.map((val, idx) => ({ batchIdx: idx, addr: val })),
            path:      []
        }];

        for (let depth = 1; depth <= maxDepth; depth++) {
            const nextLevel = [];

            for (const state of currentLevel) {
                const bitmaps = state.addresses.map(curr =>
                    this.buildChunkBitmap(curr.addr, curr.batchIdx, batchIndexes[curr.batchIdx], chunkStart, chunkEnd)
                );
                const common = this.andBitmaps(bitmaps);

                this.iterateOffsets(common, (offset) => {
                    const actual    = chunkStart + offset;
                    const nextAddrs = [];
                    let allValid    = true;

                    for (const curr of state.addresses) {
                        const idx = batchIndexes[curr.batchIdx].get(curr.addr);
                        if (idx === undefined) { allValid = false; break; }
                        const nextAddr = this.batches[curr.batchIdx].values[idx] + actual;
                        if (!batchIndexes[curr.batchIdx].has(nextAddr)) { allValid = false; break; }
                        nextAddrs.push({ batchIdx: curr.batchIdx, addr: nextAddr });
                    }

                    if (!allValid) return;

                    if (targets.has(nextAddrs[0].addr) && nextAddrs.every(na => targets.has(na.addr))) {
                        const targetAddr    = nextAddrs[0].addr;
                        const structureInfo = this.findStructureForNode(targetAddr);
                        if (structureInfo) {
                            validPaths.push({
                                fullPath:      [...state.path, actual],
                                targetAddress: targetAddr,
                                structureSize: structureInfo.nodeCount,
                                stride:        structureInfo.stride
                            });
                            foundStructures.add(structureInfo.root);
                        }
                        return;
                    }

                    if (nextLevel.length < maxStatesPerDepth) {
                        nextLevel.push({ depth, addresses: nextAddrs, path: [...state.path, actual] });
                    }
                });

                if (validPaths.length >= 10) return validPaths;
            }

            currentLevel = nextLevel;
            if (currentLevel.length === 0) break;
        }

        return validPaths;
    }

    // =========================================================================
    // Bitmap utilities
    // =========================================================================

    buildChunkBitmap(addr, batchIdx, addrIndex, chunkStart, chunkEnd) {
        const batch  = this.batches[batchIdx];
        const idx    = addrIndex.get(addr);
        if (idx === undefined) return [0, 0, 0, 0];

        const value  = batch.values[idx];
        const bitmap = [0, 0, 0, 0];

        for (let offset = chunkStart; offset < chunkEnd; offset += 4) {
            if (addrIndex.has(value + offset)) {
                const rel    = (offset - chunkStart) / 4;
                const arrIdx = Math.floor(rel / 32);
                const bitIdx = rel % 32;
                if (arrIdx < 4) bitmap[arrIdx] |= (1 << bitIdx);
            }
        }

        return bitmap;
    }

    iterateOffsets(bitmap, callback) {
        for (let i = 0; i < bitmap.length; i++) {
            if (bitmap[i] === 0) continue;
            for (let bit = 0; bit < 32; bit++) {
                if (bitmap[i] & (1 << bit)) callback((i * 32 + bit) * 4);
            }
        }
    }

    andBitmaps(bitmaps) {
        if (bitmaps.length === 0) return [];
        const result = [...bitmaps[0]];
        for (let i = 1; i < bitmaps.length; i++) {
            for (let j = 0; j < result.length; j++) result[j] &= bitmaps[i][j];
        }
        return result;
    }

    // =========================================================================
    // Utilities
    // =========================================================================

    collectAllTargetNodes() {
        const targets = new Set();
        for (const s of this.structures) {
            if (s.addresses) {
                s.addresses.forEach(a => targets.add(a));
            } else if (s.root) {
                const stride = s.stride || 4;
                const count  = s.nodeCount || 1;
                for (let i = 0; i < count; i++) targets.add(s.root + i * stride);
            }
        }
        return targets;
    }

    findStructureForNode(nodeAddr) {
        for (const s of this.structures) {
            if (s.addresses && s.addresses.includes(nodeAddr)) return s;
            if (s.root) {
                const stride = s.stride || 4;
                const count  = s.nodeCount || 1;
                for (let i = 0; i < count; i++) {
                    if (s.root + i * stride === nodeAddr) return s;
                }
            }
        }
        return null;
    }

    finalizeStructures() {
        for (const s of this.structures) {
            s.achievementRange = (s.ordered && s.stride > 0)
                ? Math.min(s.stride - 4, 0x100)
                : 0x100;
        }
        console.log(`Finalized: ${this.structures.length} structures`);
    }
}
