/**
 * =============================================================================
 * BDRAM Scanner - Preprocessor
 *
 * Manages the unified Node pool across uploaded batches and produces:
 *   - Per-range StaticNode / StaticStatic counts for the UI
 *   - Soft recommendations for SkipSticky and range awareness
 *   - Pre-sized classified arrays ready for the scanner to consume
 *
 * Data model
 * ----------
 * this.nodeMap : Map<address, Int32Array(maxBatches)>
 *
 *   slots[b] === 0  → address absent from batch b
 *                     (0 is never a valid post-validation pointer value)
 *   slots[b] !== 0  → validated (unmasked) pointer value for batch b
 *
 * Classification (computed on demand, never stored separately):
 *
 *   StaticStatic — unique non-zero count === 1
 *                  Same address, same value in every batch it appears.
 *                  Contains static structures AND base ptrs that didn't move.
 *
 *   StaticNode   — unique non-zero count > 1, zero count === 0
 *                  Same address in ALL batches, values differ.
 *                  High probability base pointer.
 *
 *   DynamicNode  — at least one zero slot
 *                  Address missing from one or more batches.
 *
 * On Process:
 *   1. Apply system mask to all non-zero values in-memory.
 *   2. Re-classify and route to three pre-sized flat arrays.
 *   3. Discard this.nodeMap to free memory.
 * =============================================================================
 */

class Preprocessor {

    constructor() {
        this.systemId   = null;
        this.batchCount = 0;
        this.maxBatches = Config.get('maxFiles'); // 10

        // address (number) → Int32Array(maxBatches) of unmasked validated values
        this.nodeMap = new Map();

        // Cached counts — invalidated whenever the pool changes
        this._countsCache = null;
    }

    // =========================================================================
    // Public API
    // =========================================================================

    /**
     * Reset all state.
     * Called when system changes or all files are cleared.
     */
    reset() {
        this.systemId   = null;
        this.batchCount = 0;
        this.nodeMap.clear();
        this._countsCache = null;
        console.log('Preprocessor: reset');
    }

    /**
     * Set (or change) the active system.
     * Resets all batch data if the system changes.
     */
    setSystem(systemId) {
        if (!Config.isValidSystem(systemId)) {
            throw new Error(`Unknown system: "${systemId}"`);
        }
        if (this.systemId !== systemId) {
            this.reset();
            this.systemId = systemId;
            console.log(`Preprocessor: system set to "${systemId}"`);
        }
    }

    /**
     * Add a parsed and validated batch to the node pool.
     *
     * parsedBatch: { addresses: number[], values: number[] }
     *   Values are unmasked, range-validated integers from CoreUtils.parseCSV.
     *
     * Returns the updated getCounts() summary for immediate UI update.
     */
    addBatch(parsedBatch) {
        if (!this.systemId) throw new Error('Call setSystem() before addBatch()');
        if (this.batchCount >= this.maxBatches) {
            throw new Error(`Maximum of ${this.maxBatches} batches reached`);
        }

        const batchIndex        = this.batchCount;
        const { addresses, values } = parsedBatch;
        const mask              = Config.getSystemMask(this.systemId); // may be null

        // -----------------------------------------------------------------
        // Pass 1 — VTable anchor removal (per-batch, no masking needed).
        //
        // A value that appears as the target of more than 10 different
        // addresses within this single batch is almost certainly a VTable
        // or other shared anchor rather than a meaningful pointer.  We
        // collect the frequency map first, then build a keep-set.
        // -----------------------------------------------------------------
        const valueFreq = new Map();
        for (let i = 0; i < values.length; i++) {
            const v = values[i];
            valueFreq.set(v, (valueFreq.get(v) || 0) + 1);
        }

        const vtableValues = new Set();
        for (const [v, count] of valueFreq) {
            if (count > 10) vtableValues.add(v);
        }

        // -----------------------------------------------------------------
        // Pass 2 — Close proximity removal.
        //
        // Nodes where (address − maskedValue) falls in the range (-44, 4]
        // are self-referential artefacts.  The mask is applied temporarily
        // for the check only; the unmasked value is what gets stored.
        // -----------------------------------------------------------------
        let removedVtable    = 0;
        let removedProximity = 0;

        for (let i = 0; i < addresses.length; i++) {
            const addr = addresses[i];
            const val  = values[i];   // unmasked

            // VTable anchor check
            if (vtableValues.has(val)) { removedVtable++; continue; }

            // Close proximity check — use masked value for the distance test
            const maskedVal = (mask !== null) ? (val & mask) >>> 0 : val;
            const diff      = addr - maskedVal;
            if (diff >= -44 && diff <= 4) { removedProximity++; continue; }

            // Node passes both filters — store unmasked
            if (!this.nodeMap.has(addr)) {
                const slots       = new Int32Array(this.maxBatches);
                slots[batchIndex] = val;
                this.nodeMap.set(addr, slots);
            } else {
                this.nodeMap.get(addr)[batchIndex] = val;
            }
        }

        this.batchCount++;
        this._countsCache = null;

        console.log(
            `Preprocessor: batch ${batchIndex} added — ` +
            `${addresses.length} raw entries → ` +
            `${removedVtable} VTable anchors removed, ` +
            `${removedProximity} close-proximity removed, ` +
            `pool size now ${this.nodeMap.size}`
        );

        return this.getCounts();
    }

    /**
     * Remove a batch by index and compact the pool.
     *
     * Slots above the removed index shift down by one position.
     * Addresses whose every slot is now zero are pruned from the map.
     *
     * Returns the updated getCounts() summary.
     */
    removeBatch(batchIndex) {
        if (batchIndex < 0 || batchIndex >= this.batchCount) {
            throw new Error(`Invalid batch index: ${batchIndex}`);
        }

        const toDelete = [];
        const newCount = this.batchCount - 1;

        for (const [addr, slots] of this.nodeMap) {
            // Shift: everything above the removed index moves down one
            for (let b = batchIndex; b < this.maxBatches - 1; b++) {
                slots[b] = slots[b + 1];
            }
            slots[this.maxBatches - 1] = 0;

            // Prune if all remaining slots are zero
            let anyNonZero = false;
            for (let b = 0; b < newCount; b++) {
                if (slots[b] !== 0) { anyNonZero = true; break; }
            }
            if (!anyNonZero) toDelete.push(addr);
        }

        for (const addr of toDelete) this.nodeMap.delete(addr);

        this.batchCount = newCount;
        this._countsCache = null;

        console.log(
            `Preprocessor: batch ${batchIndex} removed — ` +
            `pool size now ${this.nodeMap.size}, ${toDelete.length} entries pruned`
        );

        return this.getCounts();
    }

    /**
     * Compute and return classification counts and per-range breakdowns.
     * Result is cached between add/remove calls.
     *
     * Return shape:
     * {
     *   batchCount     : number,
     *   totalNodes     : number,
     *   staticStatics  : number,
     *   staticNodes    : number,
     *   dynamicNodes   : number,
     *   ranges: [
     *     { label: string, min: number, max: number,
     *       staticNodes: number, staticStatics: number }
     *     ...
     *   ],
     *   recommendation : {
     *     skipSticky       : boolean,
     *     activeRangeIndex : number,   // always 0 (Range 1 is default)
     *     warning          : string|null
     *   }
     * }
     */
    getCounts() {
        if (this._countsCache) return this._countsCache;

        const systemId   = this.systemId || 'n64';
        const ranges     = Config.getRanges(systemId);
        const rangeCounts = ranges.map(r => ({
            label:         r.label,
            min:           r.min,
            max:           r.max,
            staticNodes:   0,
            staticStatics: 0
        }));

        let totalStaticStatics = 0;
        let totalStaticNodes   = 0;
        let totalDynamic       = 0;

        for (const [addr, slots] of this.nodeMap) {
            const cls = this._classify(slots);

            if      (cls === 'staticStatic') totalStaticStatics++;
            else if (cls === 'staticNode')   totalStaticNodes++;
            else                             totalDynamic++;

            const ri = this._getRangeIndex(ranges, addr);
            if (ri >= 0) {
                if      (cls === 'staticStatic') rangeCounts[ri].staticStatics++;
                else if (cls === 'staticNode')   rangeCounts[ri].staticNodes++;
            }
        }

        this._countsCache = {
            batchCount:   this.batchCount,
            totalNodes:   this.nodeMap.size,
            staticStatics: totalStaticStatics,
            staticNodes:   totalStaticNodes,
            dynamicNodes:  totalDynamic,
            ranges:        rangeCounts,
            recommendation: this._buildRecommendation(
                rangeCounts, totalStaticNodes, totalStaticStatics
            )
        };

        return this._countsCache;
    }

    /**
     * Apply the system mask in-memory, classify all nodes, and partition them
     * into three pre-sized typed arrays.
     *
     * *** Deletes this.nodeMap on completion. ***
     * Call this exactly once, immediately before handing off to the scanner.
     *
     * Return shape:
     * {
     *   systemId      : string,
     *   batchCount    : number,
     *   staticStatics : { addresses: Int32Array, values: Int32Array },
     *   staticNodes   : { addresses: Int32Array, values: Int32Array[] },
     *   dynamicNodes  : { addresses: Int32Array, values: Int32Array[] }
     * }
     *
     * staticStatics.values[i]   — single masked value (same in all batches)
     * staticNodes.values[i]     — Int32Array(batchCount), one value per batch
     * dynamicNodes.values[i]    — Int32Array(batchCount), 0 = absent that batch
     */
    collapse() {
        const counts = this.getCounts();
        const mask   = Config.getSystemMask(this.systemId);
        const n      = this.batchCount;

        const ssAddrs  = new Int32Array(counts.staticStatics);
        const ssVals   = new Int32Array(counts.staticStatics);
        const snAddrs  = new Int32Array(counts.staticNodes);
        const snVals   = [];
        const dynAddrs = new Int32Array(counts.dynamicNodes);
        const dynVals  = [];

        let ssIdx = 0, snIdx = 0, dynIdx = 0;

        for (const [addr, slots] of this.nodeMap) {

            // Apply mask to every non-zero slot
            if (mask !== null) {
                for (let b = 0; b < n; b++) {
                    if (slots[b] !== 0) slots[b] = (slots[b] & mask) >>> 0;
                }
            }

            const cls = this._classify(slots);

            if (cls === 'staticStatic') {
                ssAddrs[ssIdx] = addr;
                for (let b = 0; b < n; b++) {
                    if (slots[b] !== 0) { ssVals[ssIdx] = slots[b]; break; }
                }
                ssIdx++;

            } else if (cls === 'staticNode') {
                snAddrs[snIdx] = addr;
                const bv = new Int32Array(n);
                for (let b = 0; b < n; b++) bv[b] = slots[b];
                snVals.push(bv);
                snIdx++;

            } else {
                dynAddrs[dynIdx] = addr;
                const bv = new Int32Array(n);
                for (let b = 0; b < n; b++) bv[b] = slots[b];
                dynVals.push(bv);
                dynIdx++;
            }
        }

        // Free the large preprocessing map
        this.nodeMap.clear();
        this._countsCache = null;

        console.log(
            `Preprocessor collapsed [${this.systemId}]: ` +
            `${ssIdx} StaticStatics, ${snIdx} StaticNodes, ${dynIdx} DynamicNodes`
        );

        return {
            systemId:      this.systemId,
            batchCount:    n,
            staticStatics: { addresses: ssAddrs, values: ssVals },
            staticNodes:   { addresses: snAddrs, values: snVals },
            dynamicNodes:  { addresses: dynAddrs, values: dynVals }
        };
    }

    // =========================================================================
    // Internal helpers
    // =========================================================================

    /**
     * Classify a slot array for the current batchCount.
     * Returns 'staticStatic' | 'staticNode' | 'dynamicNode'
     *
     * We only need to know whether unique non-zero count is 0, 1, or >1,
     * and whether any zeros exist — so we short-circuit early.
     */
    _classify(slots) {
        let zeroFound    = false;
        let firstValue   = 0;
        let allSameValue = true;

        for (let b = 0; b < this.batchCount; b++) {
            const v = slots[b];
            if (v === 0) {
                zeroFound = true;
                // Don't break: still need to evaluate allSameValue for correctness
                // but once a zero is found the classification is DynamicNode regardless.
                // We can break here because DynamicNode wins over everything.
                break;
            }
            if (firstValue === 0) {
                firstValue = v;
            } else if (v !== firstValue) {
                allSameValue = false;
            }
        }

        if (zeroFound)    return 'dynamicNode';
        if (allSameValue) return 'staticStatic';
        return 'staticNode';
    }

    /**
     * Find which range index (0-based) contains the given address.
     * Returns -1 if outside all ranges.
     * Ranges list is typically 1–4 entries so linear scan is fine.
     */
    _getRangeIndex(ranges, address) {
        for (let i = 0; i < ranges.length; i++) {
            if (address >= ranges[i].min && address <= ranges[i].max) return i;
        }
        return -1;
    }

    /**
     * Build a soft recommendation from current counts.
     *
     * Philosophy: Range 1 is always the starting recommendation.
     * We only report whether SkipSticky would help and flag
     * if counts are high enough to warrant a MaxDepth warning.
     * No ranges are force-disabled — the user makes that call.
     *
     * Cascade:
     *   1. Range 1 total (StaticNodes + StaticStatics) ≤ 30k → no action needed.
     *   2. Total > 30k → suggest SkipSticky ON.
     *      SkipSticky removes StaticStatics from the base pointer scan,
     *      so effective count drops to just StaticNodes in Range 1.
     *   3. StaticNodes in Range 1 > 50k → strong warning, suggest lower MaxDepth.
     *   4. StaticNodes in Range 1 30k–50k with SkipSticky → mild warning.
     *

    console.log(
        `Preprocessor collapsed [${this.systemId}]: ` +
        `${ssIdx} StaticStatics, ${snIdx} StaticNodes, ${dynIdx} DynamicNodes`
    );

    return {
        systemId:      this.systemId,
        batchCount:    n,
        staticStatics: { addresses: ssAddrs, values: ssVals },
        staticNodes:   { addresses: snAddrs, values: snVals },
        dynamicNodes:  { addresses: dynAddrs, values: dynVals }
    };
}

// =========================================================================
// Internal helpers
// =========================================================================

/**
 * Classify a slot array for the current batchCount.
 * Returns 'staticStatic' | 'staticNode' | 'dynamicNode'
 *
 * We only need to know whether unique non-zero count is 0, 1, or >1,
 * and whether any zeros exist — so we short-circuit early.
 */
_classify(slots) {
    let zeroFound    = false;
    let firstValue   = 0;
    let allSameValue = true;

    for (let b = 0; b < this.batchCount; b++) {
        const v = slots[b];
        if (v === 0) {
            zeroFound = true;
            // Don't break: still need to evaluate allSameValue for correctness
            // but once a zero is found the classification is DynamicNode regardless.
            // We can break here because DynamicNode wins over everything.
            break;
        }
        if (firstValue === 0) {
            firstValue = v;
        } else if (v !== firstValue) {
            allSameValue = false;
        }
    }

    if (zeroFound)    return 'dynamicNode';
    if (allSameValue) return 'staticStatic';
    return 'staticNode';
}

/**
 * Find which range index (0-based) contains the given address.
 * Returns -1 if outside all ranges.
 * Ranges list is typically 1–4 entries so linear scan is fine.
 */
_getRangeIndex(ranges, address) {
    for (let i = 0; i < ranges.length; i++) {
        if (address >= ranges[i].min && address <= ranges[i].max) return i;
    }
    return -1;
}

/**
 * Build a soft recommendation from current counts.
 *
 * Philosophy: Range 1 is always the starting recommendation.
 * We only report whether SkipSticky would help and flag
 * if counts are high enough to warrant a MaxDepth warning.
 * No ranges are force-disabled — the user makes that call.
 *
 * Cascade:
 *   1. Range 1 total (StaticNodes + StaticStatics) ≤ 30k → no action needed.
 *   2. Total > 30k → suggest SkipSticky ON.
 *      SkipSticky removes StaticStatics from the base pointer scan,
 *      so effective count drops to just StaticNodes in Range 1.
 *   3. StaticNodes in Range 1 > 50k → strong warning, suggest lower MaxDepth.
 *   4. StaticNodes in Range 1 30k–50k with SkipSticky → mild warning.
 *
 * For 'full' range systems (GBA): no recommendation logic needed.
 * For 'half' range systems: no Range 3/4, cascade ends after step 3/4.
 */
_buildRecommendation(rangeCounts, totalStaticNodes, totalStaticStatics) {
    const cfg      = Config.getSystemConfig(this.systemId);
    const warnMax  = Config.get('warnBasePointerThreshold');   // 50 000
    const rangeMode = cfg ? cfg.rangeMode : 'half';

    if (rangeMode === 'full') {
        return { skipSticky: false, activeRangeIndex: 0, warning: null };
    }

    const range1 = rangeCounts[0] || { staticNodes: 0, staticStatics: 0 };
    const range1Total = range1.staticNodes + range1.staticStatics;

    // Always recommend SkipSticky ON, but warn if counts are high
    let warning = null;
    if (range1Total > warnMax) {
        warning = `Range 1 contains ${range1Total.toLocaleString()} total pointers. Disabling SkipSticky can increase scan time significantly.`;
    }

    return { skipSticky: true, activeRangeIndex: 0, warning };
}
}