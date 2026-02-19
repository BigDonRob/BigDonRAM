# BDRAM Scanner — How It Actually Works

This isn't a technical reference. It's a plain explanation of what the tool does with your files, why it does it, and what the output means.

---

## Step 1: Preprocessing — Cleaning Up the Data

The moment you drop in a CSV, the preprocessor reads it and immediately throws away a bunch of stuff.

**VTable anchors** — Any pointer value that shows up as the target of more than 10 different addresses gets binned. If ten different things all point to the same location, it's almost certainly a vtable or some other shared anchor. Those are noise for structure detection purposes.

**Close-proximity nodes** — If an address points to a location that's within about 44 bytes behind it (or up to 4 bytes ahead), that's treated as self-referential garbage and removed too. Real pointer chains don't loop back on themselves that tightly.

Everything that survives gets stored in a central pool indexed by address. Each entry tracks what value it had in each batch (save state) you uploaded.

When you add a second file, the same address might appear again with a different value. That's expected and intentional — it's the contrast between states that makes structure detection possible.

---

## Step 2: Classification — Sorting What's Left

Once you hit Process, every address in the pool gets sorted into one of three buckets:

**StaticStatic** — Same address, same pointer value, in every single batch. The thing it points to never moved. This could be a genuinely static data structure, or it could be a base pointer that happened to sit still across all your states. Both are useful in different ways.

**StaticNode** — Same address in all batches, but the value changes between them. This address points to different things in different states. High probability base pointer — the game stores a pointer here that gets updated as gameplay progresses.

**DynamicNode** — Missing from at least one batch. The address itself wasn't present in every state. Structures that spawn and despawn, or ones that move to a completely different location, show up here.

The classification is what lets the scanner focus its effort. You don't want to waste time running deep pointer scans on things that are probably static data. The buckets keep that sorted out.

---

## Step 3: Static Structure Detection

Static structures are hunted in the StaticStatic pool. The scanner looks for chains of addresses that are evenly spaced — address, address + stride, address + 2×stride, and so on. That pattern is the signature of an array: a contiguous block of objects all the same size.

It allows for gaps. If there's a dead entry in the middle of an otherwise clean chain, that's noted as a "ghost" node and the chain continues. This matters for things like object pools where some slots are empty.

Minimum chain length is 15 nodes, with room for up to 10 ghost slots. If the gaps are too large or too frequent, the chain gets rejected.

---

## Step 4: Dynamic Structure Detection — The Bitmap Trick

This is the main event.

For base pointer candidates (StaticNodes and, if Skip Sticky is off, StaticStatics too), the scanner tries to find structures they point into. It does this by looking at what's accessible from that address across all batches simultaneously.

The technique is bitmap intersection. For a given base pointer at depth N, the scanner builds a bitmap representing "which offsets from this address are also valid addresses?" for each batch. Then it ANDs all those bitmaps together. Whatever survives the AND is an offset that exists across every single state — meaning it's structurally consistent, not coincidental.

It does this in chunks (the Max Breadth setting controls the chunk size) and scans forward in hops (Max Depth controls how many levels deep it goes).

Discovered offsets get turned into pointer chains. If a chain of consistent offsets terminates at a cluster of addresses that look like an array or list, that's a structure. The scanner checks whether the pattern looks like a linked list (single next-pointer offset) or a tree (multiple consistent child offsets) and labels it accordingly.

This is done per-batch and requires 100% agreement across batches — if an offset only shows up in some states, it doesn't count. That's what eliminates most false positives.

---

## Step 5: Target Scanning (Optional)

If you entered target addresses, the scanner does an extra pass after structure detection. It already knows where all the structures are. Now it tries to find whether any base pointer has a path to one of your targets.

It runs a forward scan from each base pointer candidate, walking pointer chains up to Max Depth levels deep, checking at each step whether any of the reachable addresses match your target. If it finds one, it records the full offset path and flags the achievement as TARGET DETECTED.

---

## Step 6: Achievement Generation

Every detected structure gets turned into RetroAchievements logic.

**Static list achievements** — Cover every address in the array with OR conditions checking for any value change. The range includes ghost nodes. ID range starts at 100,000.

**Dynamic list / base pointer achievements** — Use the pointer chain format: start from the base pointer address, chain through offsets using indirect read operators, end at the structure and check a window of offsets around it for changes.

**Target achievements** — Same format as base pointer achievements, but the path leads to your target. These get IDs starting at 1,000 so they sort first.

Moving entry points — base pointers where the first hop landed in different places across states — get flagged in the title so you know the structure location shifts during gameplay.

---

## What the Node Counts Mean

While you're loading files, the UI shows running counts of StaticStatic, StaticNode, and DynamicNode entries. These matter for setting expectations:

A high StaticNode count in Range 1 (the primary search range) means the base pointer scan has a lot of candidates to check. That's where scan time comes from. If the count is very high and you're seeing slow scans, Skip Sticky On plus a lower Max Depth is usually the right move — it cuts the candidate pool without losing the most structurally interesting pointers.

DynamicNodes are ignored by the base pointer scan entirely. They're used only for structure validation when a target scan is running.

---

## Why Multiple States Matter So Much

Every piece of analysis in this tool depends on contrast between states. A single dump tells you nothing — every pointer in it could be coincidental. Two dumps let the tool start separating signal from noise. Four to six dumps with genuinely different game situations give the bitmap intersection enough data to rule out most garbage.

States that are too similar — same room, slightly different position — give you the same addresses with the same values in both. The intersection is trivially everything. That's why results are boring when states are too close together.

The tool is fundamentally a contrast machine. Feed it contrast.