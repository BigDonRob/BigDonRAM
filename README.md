# BDRAM Scanner — How to Use It

## Before Anything Else: Pick Your System

Nothing in the tool is clickable until you select a system from the dropdown. This isn't decoration — it controls what address ranges to search, what pointer mask to apply, how to read values, and whether the Wii compression panel shows up. Get this right first.

Supported systems include N64, GBA, GameCube, Wii, and others. If you change the system after you've already loaded files, everything resets. That's intentional.

---

## What You're Uploading

You need CSV exports from RAIntegration's pointer search. Not save states. Not memory dumps. The pointer search output.

After you pick your system, the tool tells you exactly what search values to use — something like "search greater than X and less than Y in 32-bit aligned format." Follow those numbers. They come from the system config and they matter. If your CSV isn't filtered to the right range, you'll get garbage or nothing.

**Wii users:** You need to do two searches per save state — one for Mem1, one for Mem2 — and then combine them using the compression panel before uploading. The compression panel only appears when Wii is selected. Load both files in there, trim them, compress, then upload the result.

---

## Loading Files

Drag files onto the dropzone or click it to browse. You can load up to 10 files. Each one should come from a different save state — different situations in the game, not just the same spot with slightly different values.

The tool processes each file as you add it. You'll see a running count of how many StaticStatic, StaticNode, and DynamicNode pointers it's found so far. Those numbers update live. They're also what the tool uses to recommend settings before you run the scan.

You can remove individual files if something looks wrong.

### Target Addresses (optional)

Each file slot has an optional target address field. If you know the address of something you're hunting — say, the player health pointer — enter it here. The scanner will try to trace a path from a base pointer down to that address and flag any achievements that reach it as TARGET DETECTED. If you don't have a target, leave it blank.

---

## Settings Panel

Once you have at least 2 files loaded, a settings panel appears. You don't have to touch it, but it's worth understanding.

**Max Breadth** — How wide the bitmap scan looks when searching for common offsets. Default is 0xFFC. Bigger = slower and finds more things. Smaller = faster, might miss stuff.

**Max Depth** — How many pointer hops the scanner follows. Default is 12. Deeply nested structures need higher values but take longer. If you're getting slow scans, lower this first.

**Skip Sticky Pointers** — On by default. This removes StaticStatic pointers from the base pointer scan. StaticStatics are addresses that never change value across any of your states — they're often static data or anchors that aren't useful as base pointers. Turning this off makes the scan slower and noisier. Leave it on unless you have a specific reason not to.

**Early Out (Base Pointer / Target)** — Shortcuts that stop scanning once a match is found. Useful if you're in a hurry or just want one result. Off by default for thoroughness.

**Range Toggles** — Your address space is split into ranges. Range 1 is the default. You can enable additional ranges if you think your target structures live outside the main pointer region. The tool recommends starting with Range 1 and expanding if results are thin.

---

## Running the Scan

Click Process. A progress bar and stage indicators show you what's happening:

1. Parse — reads the preprocessor output
2. Detect — finds static structures (arrays living at fixed addresses)
3. Scan — finds dynamic structures (things that move, linked lists, object pools)
4. Validate — if you gave target addresses, traces paths to them
5. Generate — builds the achievement logic

Expect this to take anywhere from a few seconds to a few minutes depending on file size, depth setting, and how many ranges you have active.

---

## Results

When the scan finishes you get:

- **Static Tests** — achievements for structures that sat at fixed addresses across all your states. Download as a .txt file.
- **Dynamic Tests** — achievements for structures that moved between states. Download as a .txt file.
- **Target Paths** — if you used target addresses and the scanner found a route to them, paths are shown here and can be copied directly.

The stats card shows how many structures were found, how many achievements were generated (split by static vs dynamic), and how long it took.

---

## What to Do With the Output

Load the .txt files into RAIntegration as test achievements. Enable a few, play the game, see what triggers. Achievements that fire consistently when they should are probably real structures. Ones that never fire or fire constantly are false positives — delete them.

This is a filter-not-a-guarantee workflow. Generate a lot, test, keep the good ones, throw away the rest. The tool does the tedious part. You still have to verify.

---

## When Things Go Wrong

**Nothing found** — Your states are too similar. Load saves from genuinely different situations: menu vs gameplay, full inventory vs empty, different levels, different characters. The scanner finds structure by contrast.

**Way too much found** — Normal. Filter it. Start with the TARGET DETECTED achievements if you used target addresses, since those are the highest-confidence results.

**Really slow** — Lower Max Depth. Disable extra ranges. Check that your CSVs aren't enormous — if they are, use the trimmed download feature to cut them down before re-importing.

**Wii scan is empty** — Make sure you actually ran the compression step and uploaded the combined file, not one of the individual Mem1/Mem2 exports.