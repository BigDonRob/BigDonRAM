/**
 * =============================================================================
 * BDRAM Scanner - Core Utilities
 * Shared utilities, configuration, and event system
 * =============================================================================
 */

class CoreUtils {

    /**
     * Format bytes to human readable string
     */
    static formatBytes(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    /**
     * Format integer address as uppercase hex string with 0x prefix.
     * padding = minimum number of hex digits (zero-filled).
     */
    static formatHex(address, padding = 8) {
        return '0x' + address.toString(16).toUpperCase().padStart(padding, '0');
    }

    /**
     * Parse hex string (with or without 0x prefix) to integer.
     */
    static parseHex(hexStr) {
        if (typeof hexStr !== 'string') return NaN;
        return parseInt(hexStr.replace(/^0x/i, ''), 16);
    }

    /**
     * Validate a hex string — accepts optional 0x/0X prefix.
     */
    static isValidHex(str) {
        if (typeof str !== 'string' || str.trim() === '') return false;
        return /^(0[xX])?[0-9a-fA-F]+$/.test(str.trim());
    }

    /**
     * Count set bits in a 32-bit integer.
     */
    static countBits(n) {
        n = n >>> 0;
        let count = 0;
        while (n) {
            count += n & 1;
            n >>>= 1;
        }
        return count;
    }

    /**
     * Debounce a function call.
     */
    static debounce(func, wait) {
        let timeout;
        return function (...args) {
            clearTimeout(timeout);
            timeout = setTimeout(() => func(...args), wait);
        };
    }

    /**
     * Promise that resolves after ms milliseconds.
     */
    static delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Validate and sanitize a single CSV row against system memory rules.
     * Returns { address: number, value: number } or null if invalid.
     *
     * Does NOT apply the system mask — masking happens at preprocess time only,
     * after the user initiates processing.
     *
     * Rules applied:
     *   1. Address and Value columns must parse as hex integers.
     *   2. Value must be 4-byte aligned (value & 3 === 0).
     *   3. Value must fall within the system's accepted memory range(s).
     */
    static validateCsvRow(row, systemId = 'n64') {
        if (!row || typeof row !== 'object') return null;

        const keys       = Object.keys(row);
        const addressKey = keys[Config.get('addressColumn')];
        const valueKey   = keys[Config.get('valueColumn')];

        if (!addressKey || !valueKey) return null;

        const rawAddress = row[addressKey];
        const rawValue   = row[valueKey];
        if (!rawAddress || !rawValue) return null;

        const address = this.parseHex(rawAddress.toString().trim());
        const value   = this.parseHex(rawValue.toString().trim());
        if (isNaN(address) || isNaN(value)) return null;

        // 4-byte alignment on the value (pointer target must be aligned)
        if ((value & Config.get('alignmentMask')) !== 0) return null;

        // System memory range check
        const systemConfig = Config.getSystemConfig(systemId);
        if (!systemConfig) return { address, value };

        if (systemConfig.dualRange && Array.isArray(systemConfig.memoryRange)) {
            // Wii: bit 31 must be set; bit 28 selects MEM1 vs MEM2
            if ((value & 0x80000000) === 0) return null;
            const isInMem1  = (value & 0x10000000) === 0;
            const rangeSpec = isInMem1 ? systemConfig.memoryRange[0] : systemConfig.memoryRange[1];
            if (value < (rangeSpec.min + 1) || value > rangeSpec.max) return null;
        } else {
            const range = systemConfig.memoryRange;
            if (value < (range.min + 1) || value > range.max) return null;
        }

        return { address, value };
    }

    /**
     * Parse and validate a full CSV text string.
     * Returns { addresses: number[], values: number[] } — integers only, no strings.
     *
     * Columns 3 and 4 are intentionally discarded.
     * Values are NOT masked here; masking is applied at preprocess time.
     */
    static async parseCSV(csvText, systemId = 'n64') {
        return new Promise((resolve, reject) => {
            Papa.parse(csvText, {
                header: true,
                skipEmptyLines: true,
                complete: (results) => {
                    try {
                        const addresses = [];
                        const values    = [];
                        let skipped     = 0;

                        for (const row of results.data) {
                            const validated = this.validateCsvRow(row, systemId);
                            if (validated) {
                                addresses.push(validated.address);
                                values.push(validated.value);
                            } else {
                                skipped++;
                            }
                        }

                        console.log(
                            `CSV parsed [${systemId}]: ${addresses.length} valid, ${skipped} skipped`
                        );
                        resolve({ addresses, values });

                    } catch (error) {
                        reject(CoreUtils.createError(
                            `CSV validation failed: ${error.message}`,
                            'CoreUtils.parseCSV'
                        ));
                    }
                },
                error: (error) => {
                    reject(CoreUtils.createError(
                        `CSV parsing error: ${error.message}`,
                        'CoreUtils.parseCSV'
                    ));
                }
            });
        });
    }

    /**
     * Build a trimmed CSV string from validated integer address/value arrays.
     *
     * Output format:
     *   Address,Value,,
     *   0x80001234,0x80005678,,
     *
     * Standard header for clean re-upload. Columns 3 and 4 are present but empty
     * so the comma structure is preserved and parseCSV column indices remain valid.
     * Values are NOT masked — this is the validated pre-mask representation.
     */
    static buildTrimmedCsv(addresses, values) {
        let csv = 'Address,Value,,\n';
        for (let i = 0; i < addresses.length; i++) {
            csv += `${CoreUtils.formatHex(addresses[i])},${CoreUtils.formatHex(values[i])},,\n`;
        }
        return csv;
    }

    /**
     * Create a structured Error object with context metadata.
     */
    static createError(message, context = '', details = {}) {
        const error     = new Error(message);
        error.context   = context;
        error.details   = details;
        error.timestamp = new Date().toISOString();
        return error;
    }

    /**
     * Absolute memory distance between two addresses.
     */
    static memoryDistance(addr1, addr2) {
        return Math.abs(addr1 - addr2);
    }
}


/**
 * =============================================================================
 * EventBus — lightweight pub/sub for cross-module communication
 * =============================================================================
 */
class EventBus {
    constructor() {
        this.events = {};
    }

    on(event, callback, context = null) {
        if (!this.events[event]) this.events[event] = [];
        this.events[event].push({ callback, context });
    }

    off(event, callback) {
        if (!this.events[event]) return;
        this.events[event] = this.events[event].filter(s => s.callback !== callback);
    }

    emit(event, data = null) {
        if (!this.events[event]) return;
        for (const subscriber of this.events[event]) {
            try {
                subscriber.context
                    ? subscriber.callback.call(subscriber.context, data)
                    : subscriber.callback(data);
            } catch (error) {
                console.error(`EventBus error [${event}]:`, error);
            }
        }
    }

    clear() {
        this.events = {};
    }
}

const globalEventBus = new EventBus();


/**
 * =============================================================================
 * Config — system definitions and global defaults
 * =============================================================================
 *
 * rangeMode controls how getRanges() divides a system's memory space:
 *
 *   'full'    — single contiguous range (very small RAM, e.g. GBA).
 *               All nodes scanned regardless; no range UI shown.
 *
 *   'half'    — two equal 50/50 ranges.
 *               Small systems: N64, PS1, DS, Dreamcast.
 *               Recommendation cascade skips straight to MaxDepth warning
 *               if Range 1 alone exceeds the threshold.
 *
 *   'quarter' — four equal 25/25/25/25 ranges.
 *               Larger systems: PS2, PSP, DSi, GameCube.
 *
 *   'wii'     — special dual-region split:
 *               Range 1 = MEM1 low half, Range 2 = MEM1 high half,
 *               Range 3 = MEM2 low half, Range 4 = MEM2 high half.
 */
class Config {

    static systems = {
        n64: {
            name: 'Nintendo 64',
            mask: null,
            memoryRange: { min: 0x80000000, max: 0x807FFFFF },
            use24Bit: true,
            rangeMode: 'half',
            size: '32-bit'
        },
        ps1: {
            name: 'PlayStation 1',
            mask: 0x001FFFFF,
            memoryRange: { min: 0x80000000, max: 0x801FFFFF },
            use24Bit: false,
            rangeMode: 'half',
            size: '32-bit'
        },
        ps2: {
            name: 'PlayStation 2',
            mask: null,
            memoryRange: { min: 0x00100000, max: 0x01FFFFFF },
            use24Bit: false,
            rangeMode: 'quarter',
            size: '32-bit'
        },
        psp: {
            name: 'PlayStation Portable',
            mask: 0x01FFFFFF,
            memoryRange: { min: 0x08000000, max: 0x09FFFFFF },
            use24Bit: false,
            rangeMode: 'quarter',
            size: '32-bit'
        },
        gba: {
            name: 'Game Boy Advance',
            mask: null,
            memoryRange: { min: 0x02000000, max: 0x0203FFFF },
            use24Bit: true,
            rangeMode: 'full',
            size: '32-bit'
        },
        ds: {
            name: 'Nintendo DS',
            mask: null,
            memoryRange: { min: 0x02000000, max: 0x023FFFFF },
            use24Bit: true,
            rangeMode: 'quater',
            size: '32-bit'
        },
        dsi: {
            name: 'Nintendo DSi',
            mask: null,
            memoryRange: { min: 0x02000000, max: 0x02FFFFFF },
            use24Bit: true,
            rangeMode: 'quarter',
            size: '32-bit'
        },
        gamecube: {
            name: 'GameCube',
            mask: 0x17FFFFFF,
            memoryRange: { min: 0x80000000, max: 0x817FFFFF },
            use24Bit: false,
            rangeMode: 'quarter',
            size: '32-bit BE'
        },
        wii: {
            name: 'Wii',
            mask: 0x13FFFFFF,
            memoryRange: [
                { min: 0x80000000, max: 0x817FFFFF }, // MEM1
                { min: 0x90000000, max: 0x93FFFFFF }  // MEM2
            ],
            use24Bit: false,
            dualRange: true,
            rangeMode: 'wii',
            size: '32-bit BE'
        },
        dreamcast: {
            name: 'Dreamcast',
            mask: null,
            memoryRange: { min: 0x8C000000, max: 0x8CFFFFFF },
            use24Bit: true,
            rangeMode: 'half',
            size: '32-bit'
        }
    };

    static defaults = {
        // Processing
        minChainLength:             5,
        maxChainLength:             100,
        minStructureNodes:          5,
        batchSize:                  1000,
        progressUpdateInterval:     100,
        minConfidence:              0.5,
        minBatchesSeen:             2,

        // UI / file handling
        maxFiles:                   10,
        maxFileSize:                2 * 1024 * 1024 * 1024,
        supportedFormats:           ['.csv'],

        // CSV column indices (0-based)
        addressColumn:              0,
        valueColumn:                1,

        // Validation
        alignmentMask:              3,      // value & 3 must === 0 for 4-byte alignment

        // Recommendation thresholds
        recommendedMaxBasePointers: 30000,
        warnBasePointerThreshold:   50000
    };

    static get(key)        { return this.defaults[key]; }
    static set(key, value) { this.defaults[key] = value; }
    static getAll()        { return { ...this.defaults }; }

    static getSystemConfig(systemId) { return this.systems[systemId] || null; }
    static getSystemMask(systemId)   { return (this.systems[systemId] || {}).mask ?? null; }
    static isValidSystem(systemId)   { return systemId in this.systems; }

    static getAllSystems() {
        return Object.keys(this.systems).map(key => ({ id: key, ...this.systems[key] }));
    }

    /**
     * Compute scan ranges for a system based on its rangeMode.
     *
     * Returns an array of: { label: string, min: number, max: number }
     *
     * Boundaries are 4-byte aligned. Ranges are contiguous and cover the full
     * memory space for the system with no gaps or overlaps.
     */
    static getRanges(systemId) {
        const cfg = this.getSystemConfig(systemId);
        if (!cfg) return [];

        // Align an address down to the nearest 4-byte boundary
        const floorAlign = addr => addr & ~3;

        switch (cfg.rangeMode) {

            case 'full': {
                const { min, max } = cfg.memoryRange;
                return [{ label: 'Range 1', min, max }];
            }

            case 'half': {
                const { min, max } = cfg.memoryRange;
                const size = max - min + 1;
                const mid  = floorAlign(min + Math.floor(size / 2));
                return [
                    { label: 'Range 1', min,     max: mid - 4 },
                    { label: 'Range 2', min: mid, max }
                ];
            }

            case 'quarter': {
                const { min, max } = cfg.memoryRange;
                const size = max - min + 1;
                const step = Math.floor(size / 4);
                const q1   = floorAlign(min + step);
                const q2   = floorAlign(min + step * 2);
                const q3   = floorAlign(min + step * 3);
                return [
                    { label: 'Range 1', min,      max: q1 - 4 },
                    { label: 'Range 2', min: q1,   max: q2 - 4 },
                    { label: 'Range 3', min: q2,   max: q3 - 4 },
                    { label: 'Range 4', min: q3,   max }
                ];
            }

            case 'wii': {
                const [mem1, mem2] = cfg.memoryRange;

                const mem1Size = mem1.max - mem1.min + 1;
                const mem1Mid  = floorAlign(mem1.min + Math.floor(mem1Size / 2));

                const mem2Size = mem2.max - mem2.min + 1;
                const mem2Mid  = floorAlign(mem2.min + Math.floor(mem2Size / 2));

                return [
                    { label: 'Range 1 (MEM1 Low)',  min: mem1.min, max: mem1Mid - 4 },
                    { label: 'Range 2 (MEM1 High)', min: mem1Mid,  max: mem1.max   },
                    { label: 'Range 3 (MEM2 Low)',  min: mem2.min, max: mem2Mid - 4 },
                    { label: 'Range 4 (MEM2 High)', min: mem2Mid,  max: mem2.max   }
                ];
            }

            default:
                return [];
        }
    }

    /**
     * Return which range index (0-based) a given address falls into.
     * Returns -1 if the address is outside all defined ranges for the system.
     */
    static getAddressRangeIndex(systemId, address) {
        const ranges = this.getRanges(systemId);
        for (let i = 0; i < ranges.length; i++) {
            if (address >= ranges[i].min && address <= ranges[i].max) return i;
        }
        return -1;
    }
}


// CommonJS export shim for non-browser environments
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { CoreUtils, EventBus, Config, globalEventBus };
}
