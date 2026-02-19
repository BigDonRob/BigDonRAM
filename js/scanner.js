/**
 * =============================================================================
 * BDRAM Scanner - Coordinator
 *
 * BDRAMScanner owns all mutable state and drives the pipeline in sequence.
 * Heavy logic lives in separate modules loaded before this file:
 *
 *   chain-walker.js   walkChainsAtOffset, resolveChainConflicts
 *   list-detector.js  detectStaticLists, detectDynamicLists
 *   forward-scanner.js buildBasePointerSet, buildBatchIndexes,
 *                      buildTraversalBitmaps, scanAllBasePointers
 *
 * processBatches() is the only public entry point.
 *
 * State owned here:
 *   batches              — raw per-batch address/value arrays (post-ingest)
 *   staticStaticNodes    — addr → single value (same in all batches)
 *   staticNodes          — addr → value[] (one per batch, all non-zero)
 *   dynamicNodes         — addr → value[] (sparse; 0 = absent for that batch)
 *   targetNodes          — Set[] per batch; destination pool for list detection
 *   basePointers         — addr → value[]; forward-scan starting points
 *   injectedTargets      — user-specified addresses to path-find
 *   structures           — detected list structures (consumed as achievements)
 *   entryPoints          — bridging nodes between structures and base pointers
 *   streamedOutput       — accumulated dynamic achievement text
 *   staticOutput         — accumulated static achievement text
 * =============================================================================
 */

class BDRAMScanner {

    constructor() {
        // System context
        this.systemId     = 'n64';
        this.systemConfig = null;

        // Scan parameters (overridden by UI before processBatches)
        this.minChainLength      = 15;
        this.maxGhostNodes       = 10;
        this.maxBreadth          = '0xFFC';
        this.maxDepth            = 12;
        this.earlyOutBasePointer = false;
        this.earlyOutTarget      = false;
        this.skipStickyPointers  = true;
        this.enabledRanges       = [0];   // 0-based range indices; [0] = Range 1

        // Node pools (populated by _ingestPreprocessorOutput + classifyNodes)
        this.batches           = [];
        this.staticStaticNodes = new Map();  // addr → value
        this.staticNodes       = new Map();  // addr → number[]
        this.dynamicNodes      = new Map();  // addr → number[]  (sparse)
        this.targetNodes       = [];         // Set[] per batch
        this.basePointers      = new Map();  // addr → number[]
        this.injectedTargets   = new Set();

        // Detection output
        this.structures  = [];
        this.entryPoints = [];
        this.targetPaths = [];

        // Counts for reporting
        this.staticStructureCount  = 0;
        this.dynamicStructureCount = 0;
        this.entryPointCount       = 0;

        // Streamed output (built incrementally to control memory)
        this.staticOutput           = '';
        this.streamedOutput         = '';
        this.staticAchievementCount  = 0;
        this.dynamicAchievementCount = 0;
        this.totalAchievementCount   = 0;
        this.processedBaseAddrs      = new Set();
        this.processedBaseAddrCount  = 0;

        // Legacy / internal
        this.vtableAnchors = new Set();
        this.generator     = null;   // set by UI controller before calling processBatches
    }

    // =========================================================================
    // Public API
    // =========================================================================

    /**
     * Main pipeline.  The preprocessor must have called collapse() already.
     *
     * @param {object}   preprocessorOutput  Result of Preprocessor.collapse()
     * @param {number[]} targetAddresses      Optional specific addresses to path-find
     */
    async processBatches(preprocessorOutput, targetAddresses = []) {
        const startTime = Date.now();
        this.systemId     = preprocessorOutput.systemId;
        this.systemConfig = Config.getSystemConfig(this.systemId);

        try {
            // ------------------------------------------------------------------
            // Stage 1 — Static List Detection
            // ------------------------------------------------------------------
            globalEventBus.emit('stage:update',    { stage: 'static-list', status: 'active' });
            globalEventBus.emit('progress:update', { percent: 10, status: 'Ingesting batch data…' });

            this._ingestPreprocessorOutput(preprocessorOutput);
            for (const t of targetAddresses) this.injectedTargets.add(t);

            globalEventBus.emit('progress:update', { percent: 11, status: 'Filtering VTable anchors…' });
            this.detectAndRemoveVTableAnchors();

            globalEventBus.emit('progress:update', { percent: 15, status: 'Filtering close-proximity nodes…' });
            this.removeCloseProximityNodes();

            globalEventBus.emit('progress:update', { percent: 20, status: 'Classifying nodes…' });
            this.classifyNodes();

            globalEventBus.emit('progress:update', { percent: 25, status: 'Detecting static lists…' });
            detectStaticLists(this);

            globalEventBus.emit('stage:update',    { stage: 'static-list', status: 'completed' });
            await _yield();

            // ------------------------------------------------------------------
            // Stage 2 — Dynamic List Detection
            // ------------------------------------------------------------------
            globalEventBus.emit('stage:update',    { stage: 'dynamic-list', status: 'active' });
            globalEventBus.emit('progress:update', { percent: 25, status: 'Detecting dynamic lists…' });
            detectDynamicLists(this);

            globalEventBus.emit('stage:update', { stage: 'dynamic-list', status: 'completed' });
            await _yield();

            // ------------------------------------------------------------------
            // Stage 3 — Precomputation
            // ------------------------------------------------------------------
            globalEventBus.emit('stage:update',    { stage: 'precompute', status: 'active' });
            globalEventBus.emit('progress:update', { percent: 26, status: 'Building base pointer set…' });

            const batchIndexes = buildBatchIndexes(this);
            buildBasePointerSet(this, batchIndexes);

            globalEventBus.emit('progress:update', { percent: 45, status: 'Precomputing offset bitmaps…' });
            const bitmapCtx = buildTraversalBitmaps(this, batchIndexes);

            globalEventBus.emit('stage:update', { stage: 'precompute', status: 'completed' });
            await _yield();

            // ------------------------------------------------------------------
            // Stage 4 — Bitmap Scanning
            // ------------------------------------------------------------------
            globalEventBus.emit('stage:update',    { stage: 'bitmap-scan', status: 'active' });
            globalEventBus.emit('progress:update', { percent: 46, status: 'Scanning base pointers…' });
            await scanAllBasePointers(this, batchIndexes, bitmapCtx);

            globalEventBus.emit('stage:update', { stage: 'bitmap-scan', status: 'completed' });
            await _yield();

            // ------------------------------------------------------------------
            // Stage 5 — Generating Achievements
            // ------------------------------------------------------------------
            globalEventBus.emit('stage:update', { stage: 'generate', status: 'active' });
            globalEventBus.emit('progress:update', { percent: 96, status: 'Generating achievements…' });
            this.streamAchievements();

            const savedBatchCount     = this.batches.length;
            const savedStructureCount = this.staticStructureCount +
                                        this.dynamicStructureCount +
                                        this.entryPointCount;

            this.clearNodePools('after_scan');

            return {
                batchCount:     savedBatchCount,
                structureCount: savedStructureCount,
                processingTime: ((Date.now() - startTime) / 1000).toFixed(1),
                structures:     this.structures,
                targetPaths:    this.targetPaths,
                staticOutput:   this.staticOutput,
                streamedOutput: this.streamedOutput,
                isStreamed:     true
            };

        } catch (err) {
            console.error('Processing error:', err);
            throw err;
        }
    }

    // Legacy stub — file parsing now lives in Preprocessor.
    async parseAllBatches() {
        console.warn('parseAllBatches() is obsolete — use processBatches(preprocessorOutput)');
    }

    // =========================================================================
    // Ingest
    // =========================================================================

    /**
     * Reconstruct this.batches[] from the collapsed preprocessor output so that
     * classifyNodes() can operate on the familiar per-batch flat arrays.
     *
     * Values in the typed arrays are already masked (Preprocessor.collapse()
     * applies the system mask before serialising).
     */
    _ingestPreprocessorOutput(output) {
        const n = output.batchCount;
        this.batches = Array.from({ length: n }, () => ({ addresses: [], values: [] }));

        // StaticStatics — value is the same in every batch.
        const { addresses: ssA, values: ssV } = output.staticStatics;
        for (let i = 0; i < ssA.length; i++) {
            for (let b = 0; b < n; b++) {
                this.batches[b].addresses.push(ssA[i]);
                this.batches[b].values.push(ssV[i]);
            }
        }

        // StaticNodes — one value per batch, all non-zero.
        const { addresses: snA, values: snV } = output.staticNodes;
        for (let i = 0; i < snA.length; i++) {
            for (let b = 0; b < n; b++) {
                if (snV[i][b] !== 0) {
                    this.batches[b].addresses.push(snA[i]);
                    this.batches[b].values.push(snV[i][b]);
                }
            }
        }

        // DynamicNodes — 0 means absent for that batch.
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
            // Batch nodes ingested
        }
    }

    // =========================================================================
    // Filter stubs (actual filtering done in Preprocessor.addBatch)
    // =========================================================================

    detectAndRemoveVTableAnchors() {
        // VTable anchor removal already applied by Preprocessor — skipping
    }

    removeCloseProximityNodes() {
        // Close proximity removal already applied by Preprocessor — skipping
    }

    // =========================================================================
    // Classification
    // =========================================================================

    /**
     * Partition the ingested batch data into three pools:
     *
     *   staticStaticNodes — address present in every batch with the same value.
     *   staticNodes       — address present in every batch, values differ.
     *   (dynamic nodes remain implicit; they are handled as a residual.)
     *
     * targetNodes is initialised here with any injected user targets.
     */
    classifyNodes() {
        // First pass: union all addresses across batches.
        const allNodes = new Map();  // addr → number[]  (one slot per batch)
        for (let b = 0; b < this.batches.length; b++) {
            const { addresses, values } = this.batches[b];
            for (let i = 0; i < addresses.length; i++) {
                const addr = addresses[i];
                if (!allNodes.has(addr)) {
                    allNodes.set(addr, new Array(this.batches.length));
                }
                allNodes.get(addr)[b] = values[i];
            }
        }

        // Second pass: classify.
        this.staticNodes       = new Map();
        this.staticStaticNodes = new Map();

        for (const [addr, vals] of allNodes) {
            // Must be present (non-zero) in every batch to be Static.
            if (!vals.every(v => v !== undefined && v !== 0)) continue;

            const first = vals[0];
            if (vals.every(v => v === first)) {
                // Same value across all batches → StaticStatic.
                this.staticStaticNodes.set(addr, first);
            } else {
                // Different values → StaticNode.
                this.staticNodes.set(addr, vals);
            }
        }

        // Initialise per-batch target pools with injected targets.
        this.targetNodes = Array.from(
            { length: this.batches.length },
            () => new Set(this.injectedTargets)
        );

        // Classification complete
    }

    // =========================================================================
    // Memory management
    // =========================================================================

    clearNodePools(stage) {
        if (stage === 'after_detect') {
            const n = this.staticStaticNodes.size;
            this.staticStaticNodes.clear();
            // Cleared staticStaticNodes after detection
            return;
        }

        if (stage === 'after_scan') {
            const batchNodeCount = this.batches.reduce(
                (s, b) => s + (b.addresses?.length || 0), 0
            );
            this.batches = [];
            // Cleared batch nodes

            const bpCount = this.basePointers.size;
            this.basePointers.clear();
            // Cleared base pointers

            const snCount = this.staticNodes.size;
            this.staticNodes.clear();
            // Cleared static nodes

            const dynCount = this.dynamicNodes.size;
            this.dynamicNodes.clear();
            // Cleared dynamic nodes

            const paCount = this.processedBaseAddrs.size;
            this.processedBaseAddrs.clear();
            // Cleared processed base addresses

            const tnCount = this.targetNodes.reduce((s, pool) => s + pool.size, 0);
            this.targetNodes = [];
            // Cleared target nodes
        }
    }

    // =========================================================================
    // Achievement streaming
    // =========================================================================

    streamAchievements() {
        if (!this.generator || this.structures.length === 0) return;

        const unprocessedEPs  = this.entryPoints.filter(
            ep => !this.processedBaseAddrs.has(ep.root)
        );
        const unprocessedSts  = this.structures.filter(
            s  => !this.processedBaseAddrs.has(s.root || s.addresses?.[0])
        );

        if (unprocessedEPs.length === 0 && unprocessedSts.length === 0) return;

        const batch        = [...unprocessedSts, ...unprocessedEPs];
        const achievements = this.generator.generateAchievements(batch);

        // Count static vs dynamic achievements
        let staticCount = 0;
        let dynamicCount = 0;
        
        for (const ach of achievements) {
            if (ach.type === 'static_list') {
                staticCount++;
            } else {
                dynamicCount++;
            }
            
            this.streamedOutput +=
                `${ach.id || ''}:"${ach.logic}":${ach.title}:${ach.description}` +
                `::::BigDonRob:0:::::00000\n`;
        }

        this.staticAchievementCount += staticCount;
        this.dynamicAchievementCount += dynamicCount;
        this.totalAchievementCount   += achievements.length;

        // Emit achievement count updates for global tracking
        globalEventBus.emit('achievement:update', { static: staticCount, dynamic: dynamicCount });

        for (const ep of unprocessedEPs) {
            this.processedBaseAddrs.add(ep.root);
            this.processedBaseAddrCount++;
        }
        for (const s of unprocessedSts) {
            const base = s.root || s.addresses?.[0];
            if (base && !this.processedBaseAddrs.has(base)) {
                this.processedBaseAddrs.add(base);
                this.processedBaseAddrCount++;
            }
        }

        this.entryPoints = this.entryPoints.filter(ep => !this.processedBaseAddrs.has(ep.root));
        this.structures  = this.structures.filter(
            s => !this.processedBaseAddrs.has(s.root || s.addresses?.[0])
        );

        console.log(
            `Streamed ${achievements.length} achievements, ` +
            `${this.structures.length} structures remaining`
        );
    }

    // =========================================================================
    // Address validation (used by forward-scanner)
    // =========================================================================

    isValidAddress(value) {
        if ((value & 3) !== 0) return false;
        if (!this.isInScanRange(value)) return false;
        const min = this.systemConfig?.memoryRange?.min ?? 0x80000000;
        const max = this.systemConfig?.memoryRange?.max ?? 0x807FFFFF;
        return value >= min && value <= max;
    }

    isInScanRange(value) {
        const allRanges = Config.getRanges(this.systemId);
        if (!allRanges || allRanges.length === 0) return true;

        const enabled = this.enabledRanges;
        if (!enabled || enabled.length === 0) return true;

        const enabledSet = enabled instanceof Set ? enabled : new Set(enabled);

        for (let i = 0; i < allRanges.length; i++) {
            if (!enabledSet.has(i)) continue;
            const r = allRanges[i];
            if (value >= r.min && value <= r.max) return true;
        }
        return false;
    }

    // =========================================================================
    // Memory diagnostics
    // =========================================================================

    getMemoryStats() {
        const stats = { heapUsed: 0, heapTotal: 0, arrays: {} };

        if (typeof process !== 'undefined' && process.memoryUsage) {
            const m = process.memoryUsage();
            stats.heapUsed  = Math.round(m.heapUsed  / 1024 / 1024);
            stats.heapTotal = Math.round(m.heapTotal  / 1024 / 1024);
        } else if (typeof performance !== 'undefined' && performance.memory) {
            const m = performance.memory;
            stats.heapUsed  = Math.round(m.usedJSHeapSize   / 1024 / 1024);
            stats.heapTotal = Math.round(m.totalJSHeapSize   / 1024 / 1024);
        }

        stats.arrays = {
            batches:            this.batches.length,
            batchNodes:         this.batches.reduce((s, b) => s + (b.addresses?.length || 0), 0),
            structures:         this.structures.length,
            entryPoints:        this.entryPoints.length,
            basePointers:       this.basePointers.size,
            staticNodes:        this.staticNodes.size,
            staticStaticNodes:  this.staticStaticNodes?.size || 0,
            targetNodes:        this.targetNodes.reduce((s, pool) => s + pool.size, 0),
            processedBaseAddrs: this.processedBaseAddrs.size,
            streamedOutputKB:   Math.round(this.streamedOutput.length / 1024),
            staticOutputKB:     Math.round(this.staticOutput.length   / 1024)
        };

        return stats;
    }

    logMemoryStats(label = '') {
        const s = this.getMemoryStats();
        console.log(`=== MEMORY ${label} ===`);
        if (s.heapUsed > 0) console.log(`Heap: ${s.heapUsed}MB / ${s.heapTotal}MB`);
        console.log(
            `Batches: ${s.arrays.batches} (${s.arrays.batchNodes} nodes) | ` +
            `Structures: ${s.arrays.structures} | EPs: ${s.arrays.entryPoints}`
        );
        console.log(
            `BPs: ${s.arrays.basePointers} | Static: ${s.arrays.staticNodes} | ` +
            `Processed: ${s.arrays.processedBaseAddrs}`
        );
        console.log(
            `Output: ${s.arrays.streamedOutputKB}KB dynamic + ${s.arrays.staticOutputKB}KB static`
        );
    }

    // Legacy / no-op kept so UI controller doesn't need updating.
    finalizeStructures() {
        console.log(`Finalized ${this.structures.length} structures`);
    }

    displayResults() {
        console.log('Early out triggered — results ready for display');
    }
}

// ---------------------------------------------------------------------------
// Module-private utility
// ---------------------------------------------------------------------------

/** Yield to the event loop (UI updates, GC). */
function _yield() {
    return new Promise(r => setTimeout(r, 0));
}
