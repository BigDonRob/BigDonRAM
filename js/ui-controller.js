/**
 * =============================================================================
 * BDRAM Scanner - UI Controller
 * =============================================================================
 *
 * Responsibilities:
 *   - System selection gate (nothing works until a system is chosen)
 *   - File upload, auto-trim, trimmed CSV download
 *   - Preprocessor invocation after each upload, UI count display update
 *   - Processing options panel (hidden until ≥2 files uploaded)
 *   - Range toggle controls and recommendation display
 *   - Wii state compression panel
 *   - Triggering the scanner and displaying results
 * =============================================================================
 */

class BDRAMUIController {

    constructor() {
        // Core state
        this.systemId    = null;
        this.files       = [];          // File objects (raw uploads)
        this.trimmedData = [];          // { addresses, values, csvText, filename } | null per slot

        // Global achievement counters
        this.globalStaticAchievementCount = 0;
        this.globalDynamicAchievementCount = 0;

        // Wii compression state
        this.wiiMemA        = null;
        this.wiiMemATrimmed = null;
        this.wiiMemB        = null;
        this.wiiMemBTrimmed = null;

        // Scan parameter state (bound to UI controls)
        this.maxBreadth          = '0xFFC';
        this.maxDepth            = 12;
        this.earlyOutBasePointer = false;
        this.earlyOutTarget      = false;
        this.skipStickyPointers  = true;
        this.enabledRanges       = new Set([0, 1, 2, 3]); // Ranges 1-4 by default

        // Core modules
        this.preprocessor    = new Preprocessor();
        this.scanner         = new BDRAMScanner();
        this.generator       = new AchievementGenerator();
        this.processedResult = null;

        this._initDOM();
        this._initEventListeners();
        this._updateGate();
    }

    // =========================================================================
    // DOM initialisation
    // =========================================================================

    _initDOM() {
        // Generate file upload grid rows (10 slots, rendered dynamically)
        this._renderFileGrid();

        // Processing options panel starts hidden
        document.getElementById('processingOptionsPanel').style.display = 'none';

        // Processing section starts hidden
        document.getElementById('processingSection').style.display = 'none';

        // Results section starts hidden
        document.getElementById('resultsSection').style.display = 'none';

        // Wii section starts hidden
        document.getElementById('wiiCompressionSection').style.display = 'none';
    }

    _initEventListeners() {
        // System selector
        document.getElementById('systemSelect').addEventListener('change', (e) => {
            this._onSystemChange(e.target.value);
        });

        // Central dropzone
        const dropzone = document.getElementById('centralDropzone');
        const fileInput = document.getElementById('fileInput');
        dropzone.addEventListener('click', () => fileInput.click());
        dropzone.addEventListener('dragover',  e => { e.preventDefault(); dropzone.classList.add('dragover'); });
        dropzone.addEventListener('dragleave', e => { e.preventDefault(); dropzone.classList.remove('dragover'); });
        dropzone.addEventListener('drop',      e => { e.preventDefault(); dropzone.classList.remove('dragover'); this._onFileDrop(e); });
        fileInput.addEventListener('change',   e => this._onFileSelect(e));

        // Process button
        document.getElementById('processBtn').addEventListener('click', () => this._runProcessing());

        // Scan parameter toggles (inside processing options panel)
        document.getElementById('earlyOutBasePointer').addEventListener('click', () => this._toggleParam('earlyOutBasePointer'));
        document.getElementById('earlyOutTarget').addEventListener('click',      () => this._toggleParam('earlyOutTarget'));
        document.getElementById('skipStickyPointers').addEventListener('click',  () => this._toggleSkipSticky());

        // Max breadth / depth inputs
        document.getElementById('maxBreadth').addEventListener('input', e => {
            if (CoreUtils.isValidHex(e.target.value)) this.maxBreadth = e.target.value.trim();
        });
        document.getElementById('maxDepth').addEventListener('input', e => {
            const v = parseInt(e.target.value);
            if (v >= 1 && v <= 20) this.maxDepth = v;
        });

        // Processing options panel toggle (chevron button)
        document.getElementById('processingOptionsToggle').addEventListener('click', () => {
            this._togglePanel('processingOptionsBody', 'processingOptionsToggle');
        });

        // Wii compression panel toggle
        document.getElementById('wiiCompressionToggle').addEventListener('click', () => {
            this._togglePanel('wiiCompressionBody', 'wiiCompressionToggle');
        });

        // Wii compression file handling
        this._initWiiListeners();

        // Download buttons
        document.getElementById('downloadStaticBtn')?.addEventListener('click',  () => this._downloadStatic());
        document.getElementById('downloadDynamicBtn')?.addEventListener('click', () => this._downloadDynamic());
        document.getElementById('copyTargetPathsBtn')?.addEventListener('click', () => this._copyTargetPaths());

        // Event bus
        globalEventBus.on('progress:update', d => this._updateProgress(d.percent, d.status));
        globalEventBus.on('stage:update',    d => this._updateStage(d.stage, d.status));
        globalEventBus.on('achievement:update', d => this._updateAchievementCounts(d.static, d.dynamic));
    }

    _initWiiListeners() {
        const wiiDropzone  = document.getElementById('wiiDropzone');
        const wiiFileInput = document.getElementById('wiiFileInput');

        wiiDropzone.addEventListener('click', () => wiiFileInput.click());
        wiiDropzone.addEventListener('dragover',  e => { e.preventDefault(); wiiDropzone.classList.add('dragover'); });
        wiiDropzone.addEventListener('dragleave', e => { e.preventDefault(); wiiDropzone.classList.remove('dragover'); });
        wiiDropzone.addEventListener('drop',      e => { e.preventDefault(); wiiDropzone.classList.remove('dragover'); this._addWiiFiles(Array.from(e.dataTransfer.files)); });
        wiiFileInput.addEventListener('change',   e => this._addWiiFiles(Array.from(e.target.files)));

        document.getElementById('wiiMemATrim').addEventListener('click',  () => this._trimWiiFile('A'));
        document.getElementById('wiiMemBTrim').addEventListener('click',  () => this._trimWiiFile('B'));
        document.getElementById('wiiCompressBtn').addEventListener('click', () => this._compressWii());
        document.getElementById('wiiClearBtn').addEventListener('click',   () => this._clearWii());
    }

    // =========================================================================
    // System gate
    // =========================================================================

    _onSystemChange(value) {
        const changed = value !== this.systemId;
        this.systemId = value || null;

        if (changed) {
            // Reset everything when system changes
            this.files       = [];
            this.trimmedData = [];
            this.preprocessor.reset();
            if (this.systemId) this.preprocessor.setSystem(this.systemId);
            this._renderFileGrid();
            this._updateProcessingOptionsPanel(null);
        }

        // Show/hide Wii compression section
        document.getElementById('wiiCompressionSection').style.display =
            (this.systemId === 'wii') ? 'block' : 'none';

        if (this.systemId !== 'wii') this._clearWii();

        this._updateInstructions();
        this._updateGate();
    }

    /**
     * Enable/disable the dropzone and file controls based on system selection.
     * Nothing is interactive until a system is chosen.
     */
    _updateGate() {
        const hasSystem = !!this.systemId;
        const dropzone  = document.getElementById('centralDropzone');

        dropzone.classList.toggle('locked', !hasSystem);
        document.getElementById('fileInput').disabled = !hasSystem;

        // Process button requires system + ≥2 real files with trimmed data
        const readyFiles = this.trimmedData.filter(d => d !== null).length;
        document.getElementById('processBtn').disabled = !hasSystem || readyFiles < 2;
    }

    // =========================================================================
    // File upload + auto-trim
    // =========================================================================

    _onFileDrop(e) {
        if (!this.systemId) return; // gate
        this._addFiles(Array.from(e.dataTransfer.files));
    }

    _onFileSelect(e) {
        if (!this.systemId) return;
        this._addFiles(Array.from(e.target.files));
        e.target.value = ''; // reset so same file can be re-selected
    }

    _addFiles(newFiles) {
        const csvFiles = newFiles.filter(f => f.name.toLowerCase().endsWith('.csv'));
        if (csvFiles.length === 0) {
            this._toast('Please select CSV files only', 'error');
            return;
        }

        const maxFiles    = Config.get('maxFiles');
        const remaining   = maxFiles - this.files.length;
        const toAdd       = csvFiles.slice(0, remaining);

        if (toAdd.length < csvFiles.length) {
            this._toast(`Maximum ${maxFiles} files — only first ${toAdd.length} added`, 'warning');
        }

        for (const file of toAdd) {
            const index = this.files.length;
            this.files.push(file);
            this.trimmedData.push(null); // placeholder until trim completes
            this._renderFileGrid();
            this._autoTrim(index, file); // fires async, updates row when done
        }

        this._updateGate();
    }

    /**
     * Auto-trim: validate + filter CSV as soon as a file is uploaded.
     * Row button shows "Processing…" until complete, then "Download".
     */
    async _autoTrim(index, file) {
        this._setTrimBtn(index, 'processing');

        try {
            const text   = await file.text();
            const parsed = await CoreUtils.parseCSV(text, this.systemId);

            if (parsed.addresses.length === 0) {
                this._toast(`${file.name}: no valid rows found`, 'error');
                this._setTrimBtn(index, 'error');
                return;
            }

            const csvText = CoreUtils.buildTrimmedCsv(parsed.addresses, parsed.values);

            this.trimmedData[index] = {
                addresses: parsed.addresses,
                values:    parsed.values,
                csvText,
                filename:  file.name.replace(/\.csv$/i, '_trimmed.csv')
            };

            this._setTrimBtn(index, 'download');
            this._toast(`${file.name}: ${parsed.addresses.length.toLocaleString()} valid rows`, 'success');

            // Feed into preprocessor
            this._addBatchToPreprocessor(index);

        } catch (err) {
            console.error('Auto-trim error:', err);
            this._toast(`Failed to process ${file.name}: ${err.message}`, 'error');
            this._setTrimBtn(index, 'error');
        }

        this._updateGate();
    }

    _addBatchToPreprocessor(index) {
        const data = this.trimmedData[index];
        if (!data) return;

        try {
            const counts = this.preprocessor.addBatch({
                addresses: data.addresses,
                values:    data.values
            });
            this._updateProcessingOptionsPanel(counts);
        } catch (err) {
            console.error('Preprocessor error:', err);
        }
    }

    _downloadTrimmedFile(index) {
        const data = this.trimmedData[index];
        if (!data) return;
        this._downloadBlob(data.csvText, data.filename, 'text/csv');
        this._toast(`Downloaded ${data.filename}`, 'success');
    }

    removeFile(index) {
        // Remove from preprocessor first
        try {
            const counts = this.preprocessor.removeBatch(index);
            this._updateProcessingOptionsPanel(counts);
        } catch (err) {
            // If batch wasn't fully processed yet, just reset counts
            console.warn('removeBatch:', err.message);
        }

        this.files.splice(index, 1);
        this.trimmedData.splice(index, 1);
        this._renderFileGrid();
        this._updateGate();
    }

    // =========================================================================
    // File grid rendering
    // =========================================================================

    _renderFileGrid() {
        const grid = document.getElementById('fileUploadGrid');
        grid.innerHTML = '';

        for (let i = 0; i < this.files.length; i++) {
            const file    = this.files[i];
            const trimmed = this.trimmedData[i];

            const row = document.createElement('div');
            row.className   = 'file-upload-row has-file';
            row.id          = `fileRow-${i}`;

            row.innerHTML = `
                <div class="file-info">
                    <p class="file-filename">${file.name}</p>
                    <span class="file-size">${CoreUtils.formatBytes(file.size)}</span>
                </div>
                <button class="btn btn-trim" id="trimBtn-${i}" disabled>Processing…</button>
                <div class="file-spacer"></div>
                <div class="target-input-wrapper">
                    <span class="target-label">Target:</span>
                    <input type="text" class="target-address-input" placeholder="0x00000000" maxlength="10">
                </div>
                <button class="btn btn-remove" onclick="uiController.removeFile(${i})">×</button>
            `;

            grid.appendChild(row);

            // Restore trim button state if data already exists
            if (trimmed !== null) {
                this._setTrimBtn(i, 'download');
            }
        }

        // Wire download buttons after rendering
        for (let i = 0; i < this.files.length; i++) {
            const btn = document.getElementById(`trimBtn-${i}`);
            if (btn && this.trimmedData[i] !== null) {
                btn.addEventListener('click', () => this._downloadTrimmedFile(i));
            }
        }
    }

    _setTrimBtn(index, state) {
        const btn = document.getElementById(`trimBtn-${index}`);
        if (!btn) return;

        btn.disabled = (state !== 'download');

        switch (state) {
            case 'processing': btn.textContent = 'Processing…'; btn.className = 'btn btn-trim processing'; break;
            case 'download':   btn.textContent = 'Download';    btn.className = 'btn btn-trim download';   break;
            case 'error':      btn.textContent = 'Error';       btn.className = 'btn btn-trim error';      break;
        }
    }

    // =========================================================================
    // Processing options panel
    // =========================================================================

    /**
     * Update the processing options panel with current preprocessor counts.
     * Panel is hidden until ≥2 files are fully trimmed and in the pool.
     *
     * @param {Object|null} counts — result of preprocessor.getCounts(), or null to reset
     */
    _updateProcessingOptionsPanel(counts) {
        const panel = document.getElementById('processingOptionsPanel');

        // Require ≥2 batches with data before showing panel
        const readyCount = this.trimmedData.filter(d => d !== null).length;
        if (!counts || readyCount < 2) {
            panel.style.display = 'none';
            return;
        }

        panel.style.display = 'block';

        // Total counts
        document.getElementById('ppTotalStaticStatics').textContent = counts.staticStatics.toLocaleString();
        document.getElementById('ppTotalStaticNodes').textContent   = counts.staticNodes.toLocaleString();
        document.getElementById('ppTotalDynamic').textContent       = counts.dynamicNodes.toLocaleString();

        // Range breakdown
        this._renderRangeBreakdown(counts);

        // Recommendation text
        this._renderRecommendation(counts.recommendation);

        // Apply recommendation defaults (only when first populating — don't override user changes)
        // SkipSticky is always ON by default now - no recommendations needed
        if (counts.batchCount === 2) {
            // Only show warning if present
            if (counts.recommendation?.warning) {
                this._renderRecommendation(counts.recommendation);
            }
        }
    }

    _renderRangeBreakdown(counts) {
        const container = document.getElementById('rangeBreakdownContainer');
        if (!container) return;
        container.innerHTML = '';

        const ranges    = counts.ranges;
        const rangeMode = Config.getSystemConfig(this.systemId)?.rangeMode;
        const showSticky = !this.skipStickyPointers; // StaticStatics are only base pointers when SkipSticky is OFF

        // Full-range systems (e.g. GBA): no range selection, just informational
        if (rangeMode === 'full') {
            const statics  = (ranges[0]?.staticNodes   || 0).toLocaleString();
            const stickies = (ranges[0]?.staticStatics || 0).toLocaleString();
            container.innerHTML = `
                <div class="range-info-row">
                    <span class="range-info-label">Full scan — small RAM, no range filtering needed</span>
                    <span class="range-count-pill statics">${statics} Statics</span>
                    ${showSticky ? `<span class="range-count-pill stickies">${stickies} StaticStatics</span>` : ''}
                </div>`;
            return;
        }

        for (let i = 0; i < ranges.length; i++) {
            const r      = ranges[i];
            const active = this.enabledRanges.has(i);

            const row = document.createElement('div');
            row.className = `range-row${active ? ' range-row--active' : ''}`;
            row.dataset.rangeIndex = i;

            row.innerHTML = `
                <button class="range-pill-toggle${active ? ' active' : ''}" data-range-index="${i}" title="${active ? 'Click to disable' : 'Click to enable'}">
                    <span class="range-pill-indicator"></span>
                    <span class="range-pill-label">${r.label}</span>
                </button>
                <span class="range-count-pill statics">${r.staticNodes.toLocaleString()} Statics</span>
                ${showSticky ? `<span class="range-count-pill stickies">${r.staticStatics.toLocaleString()} StaticStatics</span>` : ''}
            `;
            container.appendChild(row);
        }

        // Wire toggle buttons
        container.querySelectorAll('.range-pill-toggle').forEach(btn => {
            btn.addEventListener('click', () => {
                const idx = parseInt(btn.dataset.rangeIndex);
                if (this.enabledRanges.has(idx)) {
                    // Always keep at least one range enabled
                    if (this.enabledRanges.size > 1) {
                        this.enabledRanges.delete(idx);
                        btn.classList.remove('active');
                        btn.closest('.range-row').classList.remove('range-row--active');
                    }
                } else {
                    this.enabledRanges.add(idx);
                    btn.classList.add('active');
                    btn.closest('.range-row').classList.add('range-row--active');
                }
            });
        });
    }

    _renderRecommendation(rec) {
        const box = document.getElementById('recommendationBox');
        if (!rec || (!rec.warning && !rec.skipSticky)) {
            box.style.display = 'none';
            return;
        }

        box.style.display = 'block';
        let html = '';

        if (rec.skipSticky) {
            html += `<p class="rec-suggest">💡 Skip Sticky Pointers is recommended to reduce base pointer count.</p>`;
        }
        if (rec.warning) {
            html += `<p class="rec-warn">⚠️ ${rec.warning}</p>`;
        }

        box.innerHTML = html;
    }

    /**
     * Apply recommendation defaults only on the first two-file population.
     * User toggles after this point are respected as overrides.
     */
    _applyRecommendation(rec) {
        if (!rec) return;
        if (rec.skipSticky !== this.skipStickyPointers) {
            this.skipStickyPointers = rec.skipSticky;
            this._syncToggleBtn('skipStickyPointers', this.skipStickyPointers);
        }
        // Range 1 is always the default — no change needed
    }

    // =========================================================================
    // Scan parameter toggles
    // =========================================================================

    _toggleParam(param) {
        this[param] = !this[param];
        this._syncToggleBtn(param, this[param]);
        console.log(`${param}: ${this[param]}`);
    }

    _toggleSkipSticky() {
        this.skipStickyPointers = !this.skipStickyPointers;
        this._syncToggleBtn('skipStickyPointers', this.skipStickyPointers);
        console.log(`skipStickyPointers: ${this.skipStickyPointers}`);
        // Re-render range breakdown — StaticStatics column only shows when SkipSticky is OFF
        const counts = this.preprocessor?.getCounts?.();
        if (counts) this._renderRangeBreakdown(counts);
    }

    _syncToggleBtn(id, active) {
        const btn = document.getElementById(id);
        if (!btn) return;
        btn.classList.toggle('active', active);
    }

    // =========================================================================
    // Panel toggle (chevron open/close)
    // =========================================================================

    _togglePanel(bodyId, toggleId) {
        const body   = document.getElementById(bodyId);
        const toggle = document.getElementById(toggleId);
        const isOpen = body.style.display !== 'none';
        body.style.display   = isOpen ? 'none' : 'block';
        toggle.textContent   = isOpen ? '▶' : '▼';
    }

    // =========================================================================
    // Wii state compression
    // =========================================================================

    _addWiiFiles(files) {
        const csvFiles = files.filter(f => f.name.toLowerCase().endsWith('.csv'));
        if (csvFiles.length === 0) { this._toast('CSV files only', 'error'); return; }

        let added = 0;
        if (!this.wiiMemA && csvFiles.length > 0) { this.wiiMemA = csvFiles[0]; this.wiiMemATrimmed = null; added++; }
        if (!this.wiiMemB && csvFiles.length > 1) { this.wiiMemB = csvFiles[1]; this.wiiMemBTrimmed = null; added++; }
        else if (!this.wiiMemB && csvFiles.length === 1 && this.wiiMemA) { this.wiiMemB = csvFiles[0]; this.wiiMemBTrimmed = null; added++; }

        if (added > 0) { this._updateWiiDisplay(); this._toast(`Added ${added} Wii file(s)`, 'success'); }
        else this._toast('Both Mem A and Mem B slots are full', 'warning');
    }

    async _trimWiiFile(slot) {
        const file    = slot === 'A' ? this.wiiMemA    : this.wiiMemB;
        const trimmed = slot === 'A' ? this.wiiMemATrimmed : this.wiiMemBTrimmed;

        if (!file) return;

        if (trimmed) {
            this._downloadBlob(trimmed.csvText, trimmed.filename, 'text/csv');
            this._toast(`Downloaded ${trimmed.filename}`, 'success');
            return;
        }

        const btnId = slot === 'A' ? 'wiiMemATrim' : 'wiiMemBTrim';
        const btn   = document.getElementById(btnId);
        if (btn) { btn.textContent = 'Processing…'; btn.disabled = true; }

        try {
            const text   = await file.text();
            const parsed = await CoreUtils.parseCSV(text, 'wii');

            if (parsed.addresses.length === 0) {
                this._toast(`No valid rows in Mem ${slot}`, 'error');
                return;
            }

            const csvText  = CoreUtils.buildTrimmedCsv(parsed.addresses, parsed.values);
            const data     = { csvText, filename: file.name.replace(/\.csv$/i, '_trimmed.csv'), addresses: parsed.addresses, values: parsed.values };

            if (slot === 'A') this.wiiMemATrimmed = data;
            else              this.wiiMemBTrimmed = data;

            this._updateWiiDisplay();
            this._toast(`Mem ${slot} trimmed: ${parsed.addresses.length.toLocaleString()} rows`, 'success');

        } catch (err) {
            this._toast(`Trim failed: ${err.message}`, 'error');
        }
    }

    async _compressWii() {
        if (!this.wiiMemA || !this.wiiMemB) { this._toast('Both Mem A and B required', 'error'); return; }

        try {
            this._toast('Compressing…', 'info');

            if (!this.wiiMemATrimmed) {
                const p = await CoreUtils.parseCSV(await this.wiiMemA.text(), 'wii');
                this.wiiMemATrimmed = { addresses: p.addresses, values: p.values };
            }
            if (!this.wiiMemBTrimmed) {
                const p = await CoreUtils.parseCSV(await this.wiiMemB.text(), 'wii');
                this.wiiMemBTrimmed = { addresses: p.addresses, values: p.values };
            }

            const merged = new Map();
            for (let i = 0; i < this.wiiMemATrimmed.addresses.length; i++) {
                merged.set(this.wiiMemATrimmed.addresses[i], this.wiiMemATrimmed.values[i]);
            }
            for (let i = 0; i < this.wiiMemBTrimmed.addresses.length; i++) {
                const addr = this.wiiMemBTrimmed.addresses[i];
                if (!merged.has(addr)) merged.set(addr, this.wiiMemBTrimmed.values[i]);
            }

            const sorted = Array.from(merged.entries()).sort((a, b) => a[0] - b[0]);
            let csv = 'Address,Value,,\n';
            for (const [addr, val] of sorted) {
                csv += `${CoreUtils.formatHex(addr)},${CoreUtils.formatHex(val)},,\n`;
            }

            this._downloadBlob(csv, 'wii_compressed.csv', 'text/csv');
            this._toast(`Compressed: ${sorted.length.toLocaleString()} unique entries`, 'success');

        } catch (err) {
            this._toast('Compression failed: ' + err.message, 'error');
        }
    }

    _clearWii() {
        this.wiiMemA = this.wiiMemATrimmed = this.wiiMemB = this.wiiMemBTrimmed = null;
        this._updateWiiDisplay();
    }

    _updateWiiDisplay() {
        const setRow = (slot, file, trimmed) => {
            const s = slot.toUpperCase();
            document.getElementById(`wiiMem${s}Filename`).textContent = file ? file.name : 'No file loaded';
            document.getElementById(`wiiMem${s}Size`).textContent     = file ? CoreUtils.formatBytes(file.size) : '—';
            const btn = document.getElementById(`wiiMem${s}Trim`);
            btn.disabled    = !file;
            btn.textContent = trimmed ? 'Download' : 'Trim';
        };

        setRow('A', this.wiiMemA, this.wiiMemATrimmed);
        setRow('B', this.wiiMemB, this.wiiMemBTrimmed);
        document.getElementById('wiiCompressBtn').disabled = !(this.wiiMemA && this.wiiMemB);
    }

    // =========================================================================
    // Processing
    // =========================================================================

    async _runProcessing() {
        if (!this.systemId) { this._toast('Select a system first', 'error'); return; }

        const readyIndices = this.trimmedData
            .map((d, i) => d !== null ? i : -1)
            .filter(i => i >= 0);

        if (readyIndices.length < 2) {
            this._toast('Upload and process at least 2 files first', 'error');
            return;
        }

        this._resetAllStages();
        document.getElementById('processingSection').style.display = 'block';
        document.getElementById('processingSection').scrollIntoView({ behavior: 'smooth' });

        const processBtn = document.getElementById('processBtn');
        processBtn.disabled  = true;
        processBtn.innerHTML = '<span class="btn-icon">⏳</span> Processing…';

        try {
            // Configure scanner
            this.scanner.maxBreadth          = this.maxBreadth;
            this.scanner.maxDepth            = this.maxDepth;
            this.scanner.earlyOutBasePointer = this.earlyOutBasePointer;
            this.scanner.earlyOutTarget      = this.earlyOutTarget;
            this.scanner.skipStickyPointers  = this.skipStickyPointers;
            this.scanner.enabledRanges       = Array.from(this.enabledRanges);
            this.scanner.generator           = this.generator;

            // Collapse preprocessor pool into typed arrays
            const preprocessorOutput = this.preprocessor.collapse();

            // Collect target addresses from file rows
            const targetAddresses = this._getTargetAddresses();

            const result = await this.scanner.processBatches(preprocessorOutput, targetAddresses);

            globalEventBus.emit('stage:update',    { stage: 'generate', status: 'active' });
            globalEventBus.emit('progress:update', { percent: 95, status: 'Generating achievements…' });

            this.generator.setTargetAddresses(targetAddresses);
            this.generator.updateSystem(this.systemId);

            let txtContent, achievements;

            if (result.isStreamed && result.streamedOutput) {
                txtContent   = this._streamHeader() + result.streamedOutput;
                achievements = [];
            } else {
                achievements = this.generator.generateAchievements(result.structures);
                txtContent   = this.generator.exportToTxt(achievements);
            }

            globalEventBus.emit('stage:update',    { stage: 'generate', status: 'completed' });
            globalEventBus.emit('progress:update', { percent: 100, status: 'Done!' });

            const staticContent = result.staticOutput
                ? `// AUTO-GENERATED STATIC LIST ACHIEVEMENTS\n// System: ${this.systemId}\n\n${result.staticOutput}`
                : null;

            this.processedResult = { ...result, achievements, txtContent, staticContent, systemId: this.systemId };
            this._displayResults();
            this._toast('Processing complete!', 'success');

        } catch (err) {
            console.error('Processing error:', err);
            this._toast('Processing failed: ' + err.message, 'error');
            globalEventBus.emit('stage:update', { stage: 'static-list', status: 'error' });
        } finally {
            processBtn.disabled  = false;
            processBtn.innerHTML = '<span class="btn-icon">▶</span> Process Batches';
        }
    }

    _streamHeader() {
        return '// AUTO-GENERATED TEST ACHIEVEMENTS\n// Total achievements: streamed\n\n';
    }

    _getTargetAddresses() {
        const addresses = [];
        document.querySelectorAll('.target-address-input').forEach(input => {
            const v = input.value.trim();
            if (v) {
                const parsed = parseInt(v.replace(/^0x/i, ''), 16);
                if (!isNaN(parsed) && parsed > 0) addresses.push(parsed);
            }
        });
        return addresses;
    }

    // =========================================================================
    // Results display
    // =========================================================================

    _displayResults() {
        if (!this.processedResult) return;

        const r = this.processedResult;
        document.getElementById('downloadStaticBtn').style.display =
            r.staticContent ? 'inline-flex' : 'none';

        // Update global achievement counters
        if (r.staticAchievementCount) {
            this.globalStaticAchievementCount += r.staticAchievementCount;
        }
        if (r.dynamicAchievementCount) {
            this.globalDynamicAchievementCount += r.dynamicAchievementCount;
        }

        // Update the stats grid with new IDs
        console.log('Updating stats grid:', {
            batchCount: r.batchCount,
            structureCount: r.structureCount,
            staticAchievements: this.globalStaticAchievementCount,
            dynamicAchievements: this.globalDynamicAchievementCount,
            processingTime: r.processingTime
        });
        
        const statBatchesEl = document.getElementById('statBatches');
        const statStructuresEl = document.getElementById('statStructures');
        const statStaticEl = document.getElementById('statStaticAchievements');
        const statDynamicEl = document.getElementById('statDynamicAchievements');
        const statTimeEl = document.getElementById('statTime');
        
        if (statBatchesEl) statBatchesEl.textContent = r.batchCount || 0;
        if (statStructuresEl) statStructuresEl.textContent = r.structureCount || 0;
        if (statStaticEl) statStaticEl.textContent = this.globalStaticAchievementCount;
        if (statDynamicEl) statDynamicEl.textContent = this.globalDynamicAchievementCount;
        if (statTimeEl) statTimeEl.textContent = `${r.processingTime}s`;

        this._displayTargetPaths();

        const resultsSection = document.getElementById('resultsSection');
        resultsSection.style.display = 'block';
        resultsSection.scrollIntoView({ behavior: 'smooth' });
    }

    _displayTargetPaths() {
        const card    = document.getElementById('targetPathsCard');
        const display = document.getElementById('targetPathsDisplay');
        const paths   = this.processedResult?.targetPaths;

        if (!paths || paths.length === 0) { card.style.display = 'none'; return; }

        display.textContent = paths.map(tp =>
            `${tp.basePointer} ${tp.path} → Target ${tp.targetAddress}`
        ).join('\n');
        card.style.display = 'block';
    }

    // =========================================================================
    // Download helpers
    // =========================================================================

    _downloadStatic() {
        const r = this.processedResult;
        if (!r?.staticContent) { this._toast('No static results', 'error'); return; }
        this._downloadBlob(r.staticContent, `${r.systemId}-Static-Tests.txt`, 'text/plain');
        this._toast(`Downloaded ${r.systemId}-Static-Tests.txt`, 'success');
    }

    _downloadDynamic() {
        const r = this.processedResult;
        if (!r?.txtContent) { this._toast('No dynamic results', 'error'); return; }
        this._downloadBlob(r.txtContent, `${r.systemId}-Dynamic-Tests.txt`, 'text/plain');
        this._toast(`Downloaded ${r.systemId}-Dynamic-Tests.txt`, 'success');
    }

    _copyTargetPaths() {
        const display = document.getElementById('targetPathsDisplay');
        if (!display?.textContent) { this._toast('No target paths to copy', 'warning'); return; }
        navigator.clipboard.writeText(display.textContent)
            .then(()  => this._toast('Copied!', 'success'))
            .catch(() => this._toast('Copy failed', 'error'));
    }

    _downloadBlob(content, filename, type) {
        const blob = new Blob([content], { type });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    // =========================================================================
    // Instructions text
    // =========================================================================

    _updateInstructions() {
        const el = document.querySelector('.instructions-text');
        if (!el) return;

        if (!this.systemId) {
            el.textContent = 'Select System to see value ranges for search';
            return;
        }
        
        const cfg = Config.getSystemConfig(this.systemId);
        if (!cfg) return;
        
        let instructions = `1. Load save state for search.<br>`;
        
        // Handle different memory range structures (single object vs array for Wii)
        let minHex, maxHex;
        if (Array.isArray(cfg.memoryRange)) {
            // Wii: use first range (MEM1)
            minHex = '0x' + cfg.memoryRange[0].min.toString(16).toUpperCase().padStart(8, '0');
            maxHex = '0x' + cfg.memoryRange[0].max.toString(16).toUpperCase().padStart(8, '0');
        } else {
            // Single range systems
            minHex = '0x' + cfg.memoryRange.min.toString(16).toUpperCase().padStart(8, '0');
            maxHex = '0x' + cfg.memoryRange.max.toString(16).toUpperCase().padStart(8, '0');
        }
        
        instructions += `2. Export all values in ${cfg.size} aligned format or search > ${minHex} one time and < ${maxHex} one time for smaller files and quicker exports.`;
        
        if (this.systemId === 'wii') {
            const mem2MinHex = '0x' + cfg.memoryRange[1].min.toString(16).toUpperCase().padStart(8, '0');
            const mem2MaxHex = '0x' + cfg.memoryRange[1].max.toString(16).toUpperCase().padStart(8, '0');
            instructions += ` Then repeat with a new search > ${mem2MinHex} one time and < ${mem2MaxHex} one time to compress into a single file.`;
        }
        
        instructions += `<br>3. `;
        if (this.systemId === 'wii') {
            instructions += `Load Mem1 and Mem2 searches from SAME save state into compression field for file trimming if needed.<br>`;
            instructions += `4. Upload file and enter Target Address, if needed.<br>`;
            instructions += `5. Repeat at least once with a different save state. More exports means more accurate results.`;
        } else {
            instructions += `Upload file and enter Target Address, if needed.<br>`;
            instructions += `4. Repeat at least once with a different save state. More exports means more accurate results.`;
        }
        
        el.innerHTML = instructions;
    }

    // =========================================================================
    // Progress + stage indicators
    // =========================================================================

    _updateAchievementCounts(staticCount, dynamicCount) {
        if (staticCount > 0) {
            this.globalStaticAchievementCount += staticCount;
            document.getElementById('statStaticAchievements').textContent = this.globalStaticAchievementCount;
        }
        if (dynamicCount > 0) {
            this.globalDynamicAchievementCount += dynamicCount;
            document.getElementById('statDynamicAchievements').textContent = this.globalDynamicAchievementCount;
        }
    }

    _updateProgress(percent, status) {
        const fill = document.getElementById('progressFill');
        const text = fill?.querySelector('.progress-text');
        const statusEl = document.getElementById('statusText');
        if (fill)    fill.style.width    = percent + '%';
        if (text)    text.textContent    = percent + '%';
        if (statusEl) statusEl.textContent = status;
    }

    _resetAllStages() {
        ['static', 'dynamic', 'precompute', 'scan', 'generate'].forEach(stage => {
            const el = document.querySelector(`.stage-indicator[data-stage="${stage}"]`);
            if (el) {
                el.classList.remove('active', 'completed', 'error');
                el.querySelector('.stage-status').textContent = 'Waiting';
            }
        });
    }

    _updateStage(stage, status) {
        const el = document.querySelector(`.stage-indicator[data-stage="${stage}"]`);
        if (!el) return;
        el.classList.remove('active', 'completed', 'error');
        const statusEl = el.querySelector('.stage-status');

        switch (status) {
            case 'active':    el.classList.add('active');    statusEl.textContent = 'Processing…'; break;
            case 'completed': el.classList.add('completed'); statusEl.textContent = 'Complete';    break;
            case 'skipped':   el.classList.add('completed'); statusEl.textContent = 'Skipped';     break;
            case 'error':     el.classList.add('error');     statusEl.textContent = 'Error';       break;
        }
    }

    // =========================================================================
    // Toast notifications
    // =========================================================================

    _toast(message, type = 'info') {
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.textContent = message;
        document.body.appendChild(toast);
        setTimeout(() => toast.classList.add('show'), 10);
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }
}

// Initialise on DOM ready
document.addEventListener('DOMContentLoaded', () => {
    window.uiController = new BDRAMUIController();
});