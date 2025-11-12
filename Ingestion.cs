using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;

namespace PointerAnalysis
{
    // Ingestion: parse CSV(s), mask values per platform, detect and consume backlink seeds,
    // mark regular nodes with simple flags, and build Parent/Child slots using only regular entries.
    public class Ingestion
    {
        public class Config
        {
            public int MinListLength = BookOfVariables.MinListLength;
            public int MaxChainLength = BookOfVariables.MaxChainDepth;
            public int HotReferenceThreshold = BookOfVariables.HotReferenceThreshold;
            public uint SelfDoubleScanCap = BookOfVariables.SelfDoubleScanCap;
            public uint[] SlotOffsets = (uint[])BookOfVariables.PrimarySlotOffsets.Clone();
            public int SlotAlignmentModulo = BookOfVariables.PrimarySlotAlignmentModulo;
            public bool VerboseLogging = BookOfVariables.VerboseLogging;
        }

        public class MemoryEntry
        {
            public uint Address;
            public uint Value; // masked
            public long Stride => (long)Value - (long)Address;
            public (int Forward, int Backward) ReferenceCount = (0, 0);

            // Flags set when a consumed seed pointed to this regular node
            public bool HasConsumedSelfSeed = false;
            public bool HasConsumedDoubleSeed = false;

            // Parent/Child slot arrays (dynamic size based on config). -1 means empty slot.
            public int[] ParentIndices;
            public int[] ChildIndices;

            // Diagnostic source addresses pointing at this node (consumed seed addresses)
            public List<uint> BacklinkSourceAddresses = new List<uint>();
            public bool IsHotValue = false;

            // === Advanced structure detection fields ===
            public int ValidChildSlotsCount = 0;  // How many child slots have valid children
            public int ValidParentSlotsCount = 0;  // How many parent slots have valid parents
            public bool ValueIsValidPointer = false;  // Does Value point to a known address
            public int ConsecutivePointerRun = 0;  // Length of consecutive pointer run this is part of

            public MemoryEntry(int slotCount)
            {
                ParentIndices = Enumerable.Repeat(-1, slotCount).ToArray();
                ChildIndices = Enumerable.Repeat(-1, slotCount).ToArray();
            }
        }

        public class SeedRecord
        {
            public int OriginalLineIndex = -1;
            public uint Address;
            public uint Value;
            public bool IsSelfBacklinkSeed;
            public bool IsDoubleBacklinkSeed;
            public List<uint> SourceAddresses = new List<uint>();
        }

        private readonly Config _config;

        public Ingestion(Config? config = null)
        {
            _config = config ?? throw new ArgumentNullException(nameof(config));
            if (_config.SlotOffsets == null || _config.SlotOffsets.Length == 0) 
                throw new ArgumentException("SlotOffsets must have at least one entry");
        }

        // Single-file entry
        public (List<MemoryEntry> RegularTuples, List<SeedRecord> ConsumedSeeds, int TotalForwardRefs, int TotalBackwardRefs)
            LoadEntries(string csvPath, string? platformHint = null)
            => LoadEntries(new List<string> { csvPath }, platformHint);

        // Multi-file loader (merges multiple CSVs into one logical parsed set)
        public (List<MemoryEntry> RegularTuples, List<SeedRecord> ConsumedSeeds, int TotalForwardRefs, int TotalBackwardRefs)
            LoadEntries(List<string> csvPaths, string? platformHint = null)
        {
            if (csvPaths == null || csvPaths.Count == 0) throw new ArgumentException("No input files");

            // Resolve platform descriptor from centralized BookOfVariables.Platforms
            string platformKey = platformHint ?? DetectPlatformKeyFromFileName(csvPaths.First());
            var platform = BookOfVariables.GetPlatformByHint(platformKey);

            // Parse all files into parsed tuples list (Address, RawValue, LineIndex, SourceFile)
            var parsed = new List<(uint Address, uint RawValue, int LineIndex, string SourceFile)>();
            foreach (var path in csvPaths)
            {
                var lines = File.ReadAllLines(path);
                if (lines.Length == 0) continue;

                // Skip header row if present
                int startRow = 0;
                bool hasHeader = lines[0].StartsWith("Address,") || lines[0].StartsWith("address,");
                if (hasHeader) startRow = 1;

                for (int i = startRow; i < lines.Length; i++)
                {
                    string line = lines[i].Trim();
                    if (string.IsNullOrWhiteSpace(line)) continue;

                    var parts = line.Split(',').Select(p => p.Trim()).ToArray();
                    if (parts.Length < 2) continue;

                    // Parse address and raw value as hex
                    if (!TryParseHex(parts[0], out uint addr) || !TryParseHex(parts[1], out uint rawVal))
                        continue;

                    // First validate the raw value against platform memory ranges
                    if (platform.ValidRanges.Count > 0 && 
                        !platform.ValidRanges.Any(r => rawVal >= r.Start && rawVal <= r.End))
                    {
                        continue; // Skip values outside valid memory ranges
                    }

                    // Apply platform-specific mask to the value for all future use
                    uint masked = platform.PointerMask.HasValue ? (rawVal & platform.PointerMask.Value) : rawVal;

                    parsed.Add((addr, masked, i + 1, Path.GetFileName(path)));  // +1 to make line numbers 1-based
                }
            }

            // stable sort by Address then SourceFile
            parsed = parsed.OrderBy(t => t.Address).ThenBy(t => t.SourceFile).ToList();

            // deduplicate by address across merged files, keep first occurrence
            var dedup = new List<(uint Address, uint RawValue, int LineIndex)>();
            var seen = new HashSet<uint>();
            foreach (var p in parsed)
            {
                if (seen.Add(p.Address)) dedup.Add((p.Address, p.RawValue, p.LineIndex));
            }

            // Build maps from dedup list
            var valueToParsedIdx = new Dictionary<uint, List<int>>();
            var addressToParsedIdx = new Dictionary<uint, int>();
            for (int i = 0; i < dedup.Count; i++)
            {
                addressToParsedIdx[dedup[i].Address] = i;
                if (!valueToParsedIdx.TryGetValue(dedup[i].RawValue, out var li)) { li = new List<int>(); valueToParsedIdx[dedup[i].RawValue] = li; }
                li.Add(i);
            }

            // forward/back counts
            var fbArray = new (int Forward, int Backward)[dedup.Count];
            for (int i = 0; i < dedup.Count; i++)
            {
                int f = 0, b = 0;
                var addr = dedup[i].Address;
                if (valueToParsedIdx.TryGetValue(addr, out var refs))
                {
                    foreach (var r in refs)
                    {
                        if (dedup[r].Address < addr) f++; else if (dedup[r].Address > addr) b++;
                    }
                }
                fbArray[i] = (f, b);
            }

            // hot values
            var hotValues = new HashSet<uint>(valueToParsedIdx.Where(kv => kv.Value.Count > _config.HotReferenceThreshold).Select(kv => kv.Key));

            var consumedSeeds = new List<SeedRecord>();
            var regularEntriesTemp = new List<MemoryEntry>();

            // First, create all entries as regular entries
            var allEntries = new List<MemoryEntry>();
            int slotCount = _config.SlotOffsets.Length;
            for (int i = 0; i < dedup.Count; i++)
            {
                var addr = dedup[i].Address;
                var val = dedup[i].RawValue;
                var fb = fbArray[i];
                bool isHot = hotValues.Contains(val);
                
                var me = new MemoryEntry(slotCount) 
                { 
                    Address = addr, 
                    Value = val, 
                    ReferenceCount = fb, 
                    IsHotValue = isHot 
                };
                allEntries.Add(me);
            }

            // Build temporary address to index map for all entries
            var tempAddressToIdx = new Dictionary<uint, int>(allEntries.Count);
            for (int i = 0; i < allEntries.Count; i++)
            {
                tempAddressToIdx[allEntries[i].Address] = i;
            }

            // Now detect backlinks and mark targets (keep target, discard source)
            var consumedSeedsList = new List<SeedRecord>();
            var nodesToDiscard = new HashSet<int>();

            for (int i = 0; i < allEntries.Count; i++)
            {
                var addr = allEntries[i].Address;
                var val = allEntries[i].Value;
                
                // Skip hot values
                if (allEntries[i].IsHotValue) continue;

                // Compute scan cap = min(SelfDoubleScanCap, abs(stride) - 4) if abs(stride) > 4, else 0
                uint cap = 0;
                long absStride = Math.Abs((long)val - (long)addr);
                if (absStride > 4)
                {
                    uint strideCap = (uint)Math.Min((long)_config.SelfDoubleScanCap, absStride - 4);
                    cap = strideCap;
                }

                bool foundSelf = false, foundDouble = false;
                var sources = new HashSet<uint>();

                if (cap > 0)
                {
                    // Scan for self-references: check if any node in [addr .. addr + cap] points back to addr
                    int lo = BinarySearchFirstIndexByAddress(dedup, addr);
                    uint scanEnd = unchecked(addr + cap);
                    
                    // Check for self-references
                    for (int j = lo; j < dedup.Count; j++)
                    {
                        var checkEntry = dedup[j];
                        if (checkEntry.Address > scanEnd) break;
                        
                        // If this entry's value points back to our current address, it's a self-reference
                        if (checkEntry.RawValue == addr)
                        {
                            foundSelf = true;
                            sources.Add(checkEntry.Address);
                            
                            // Mark this node (i) as target - it should be kept
                            if (tempAddressToIdx.TryGetValue(addr, out int targetIdx))
                            {
                                allEntries[targetIdx].HasConsumedSelfSeed = true;
                                allEntries[targetIdx].BacklinkSourceAddresses.Add(checkEntry.Address);
                            }
                            
                            // Discard the source node (the one pointing back)
                            if (tempAddressToIdx.TryGetValue(checkEntry.Address, out int sourceIdx))
                            {
                                nodesToDiscard.Add(sourceIdx);
                            }
                        }
                    }
                    
                    // Check for double-links
                    // For the current node's value, check if any node in [value .. value + cap] points back to addr
                    if (val != 0)
                    {
                        int valLo = BinarySearchFirstIndexByAddress(dedup, val);
                        uint valScanEnd = unchecked(val + cap);
                        
                        for (int j = valLo; j < dedup.Count; j++)
                        {
                            var checkEntry = dedup[j];
                            if (checkEntry.Address > valScanEnd) break;
                            
                            // If this entry's value points back to our current address, it's a double-link
                            if (checkEntry.RawValue == addr)
                            {
                                foundDouble = true;
                                sources.Add(checkEntry.Address);
                                
                                // Mark both the current node and its target as having double seeds
                                if (tempAddressToIdx.TryGetValue(addr, out int currentIdx))
                                {
                                    allEntries[currentIdx].HasConsumedDoubleSeed = true;
                                    allEntries[currentIdx].BacklinkSourceAddresses.Add(checkEntry.Address);
                                }
                                
                                if (tempAddressToIdx.TryGetValue(val, out int targetIdx))
                                {
                                    allEntries[targetIdx].HasConsumedDoubleSeed = true;
                                    allEntries[targetIdx].BacklinkSourceAddresses.Add(addr);
                                }
                                
                                // Discard the backlink source node
                                if (tempAddressToIdx.TryGetValue(checkEntry.Address, out int sourceIdx))
                                {
                                    nodesToDiscard.Add(sourceIdx);
                                }
                            }
                        }
                    }
                }
                else
                {
                    // cap == 0: only offset 0 checks (exact equality)
                    if (valueToParsedIdx.TryGetValue(addr, out var refs) && refs.Count > 0)
                    {
                        foundSelf = true;
                        sources.Add(dedup[refs[0]].Address);
                        
                        // Mark target and discard source
                        if (tempAddressToIdx.TryGetValue(addr, out int targetIdx))
                        {
                            allEntries[targetIdx].HasConsumedSelfSeed = true;
                            allEntries[targetIdx].BacklinkSourceAddresses.Add(dedup[refs[0]].Address);
                        }
                        nodesToDiscard.Add(refs[0]);
                    }
                    if (valueToParsedIdx.TryGetValue(val, out var refs2) && refs2.Count > 0)
                    {
                        foundDouble = true;
                        sources.Add(dedup[refs2[0]].Address);
                        
                        // Mark both nodes and discard backlink source
                        if (tempAddressToIdx.TryGetValue(addr, out int currentIdx))
                        {
                            allEntries[currentIdx].HasConsumedDoubleSeed = true;
                        }
                        if (tempAddressToIdx.TryGetValue(val, out int targetIdx))
                        {
                            allEntries[targetIdx].HasConsumedDoubleSeed = true;
                        }
                        nodesToDiscard.Add(refs2[0]);
                    }
                }

                // Record consumed seed for discarded nodes
                if ((foundSelf || foundDouble) && sources.Count > 0)
                {
                    var sd = new SeedRecord
                    {
                        OriginalLineIndex = dedup[i].LineIndex,
                        Address = addr,
                        Value = val,
                        IsSelfBacklinkSeed = foundSelf,
                        IsDoubleBacklinkSeed = foundDouble
                    };
                    sd.SourceAddresses.AddRange(sources);
                    consumedSeedsList.Add(sd);
                }
            }

            // Filter out discarded nodes
            var filteredRegularEntries = new List<MemoryEntry>();
            for (int i = 0; i < allEntries.Count; i++)
            {
                if (!nodesToDiscard.Contains(i))
                {
                    filteredRegularEntries.Add(allEntries[i]);
                }
            }

            // Sort and build address->regular index map
            filteredRegularEntries.Sort((a, b) => a.Address.CompareTo(b.Address));
            var addressToRegularIdx = new Dictionary<uint, int>(filteredRegularEntries.Count);
            for (int i = 0; i < filteredRegularEntries.Count; i++) 
                addressToRegularIdx[filteredRegularEntries[i].Address] = i;
            
            // Track list sizes and discard those over 500 nodes
            var listSizes = new Dictionary<int, int>(); // node index -> list size
            var visited = new HashSet<int>();
            const int MAX_LIST_SIZE = 500;
            
            // Function to calculate list size starting from a node
            int CalculateListSize(int nodeIdx, HashSet<int>? currentPath = null)
            {
                if (nodeIdx < 0 || nodeIdx >= filteredRegularEntries.Count) return 0;
                if (listSizes.TryGetValue(nodeIdx, out var size)) return size;
                currentPath ??= new HashSet<int>();
                if (!currentPath.Add(nodeIdx)) return 0; // cycle detected
                
                var node = filteredRegularEntries[nodeIdx];
                int listSize = 1; // count self
                
                // Check all child nodes (next pointers in the list)
                foreach (var childIdx in node.ChildIndices.Where(ci => ci != -1))
                {
                    // Only follow forward references (next pointers)
                    if (filteredRegularEntries[childIdx].Address > node.Address)
                    {
                        listSize += CalculateListSize(childIdx, new HashSet<int>(currentPath));
                        if (listSize > MAX_LIST_SIZE) break; // Early exit if we exceed max size
                    }
                }
                
                // Cache the result
                listSizes[nodeIdx] = listSize;
                return listSize;
            }
            
            // Calculate list sizes and mark nodes in lists that are too large for removal
            var nodesToRemove = new HashSet<int>();
            for (int i = 0; i < filteredRegularEntries.Count; i++)
            {
                if (!visited.Contains(i) && listSizes.GetValueOrDefault(i, 0) <= MAX_LIST_SIZE)
                {
                    int size = CalculateListSize(i);
                    if (size > MAX_LIST_SIZE)
                    {
                        // Mark all nodes in this list for removal
                        var toVisit = new Stack<int>();
                        toVisit.Push(i);
                        while (toVisit.Count > 0)
                        {
                            int current = toVisit.Pop();
                            if (visited.Add(current))
                            {
                                nodesToRemove.Add(current);
                                foreach (var childIdx in filteredRegularEntries[current].ChildIndices.Where(ci => ci != -1))
                                {
                                    if (filteredRegularEntries[childIdx].Address > filteredRegularEntries[current].Address)
                                    {
                                        toVisit.Push(childIdx);
                                    }
                                }
                            }
                        }
                    }
                }
            }
            
            // Remove nodes that are part of lists that are too large
            if (nodesToRemove.Count > 0)
            {
                filteredRegularEntries = filteredRegularEntries
                    .Where((_, idx) => !nodesToRemove.Contains(idx))
                    .ToList();
                
                // Rebuild the address index after removing nodes
                addressToRegularIdx.Clear();
                for (int i = 0; i < filteredRegularEntries.Count; i++)
                    addressToRegularIdx[filteredRegularEntries[i].Address] = i;
            }

            // Populate child/parent slots using configured SlotOffsets and mapping into filteredRegularEntries only.
            uint[] offsets = _config.SlotOffsets;
            for (int i = 0; i < filteredRegularEntries.Count; i++)
            {
                var e = filteredRegularEntries[i];
                long absStride2 = Math.Abs(e.Stride);
                uint maxOffsetAllowed = 0u;
                if (absStride2 > 4)
                {
                    long candidateMax = absStride2 - 4;
                    if (candidateMax > 0) maxOffsetAllowed = (uint)Math.Min(candidateMax, BookOfVariables.MaxOffsetToConsider);
                }

                for (int s = 0; s < offsets.Length; s++)
                {
                    uint off = offsets[s];
                    if (off > maxOffsetAllowed) break;
                    uint childAddr = unchecked(e.Value + off);
                    if (addressToRegularIdx.TryGetValue(childAddr, out int childIdx))
                    {
                        e.ChildIndices[s] = childIdx;
                        var childEntry = filteredRegularEntries[childIdx];
                        // add parent index into a free parent slot on the child
                        for (int p = 0; p < childEntry.ParentIndices.Length; p++)
                        {
                            if (childEntry.ParentIndices[p] == -1) { childEntry.ParentIndices[p] = i; break; }
                        }
                    }
                }
            }

            // === Advanced structure detection metrics ===
            for (int i = 0; i < filteredRegularEntries.Count; i++)
            {
                var entry = filteredRegularEntries[i];
                
                // Count valid child slots
                entry.ValidChildSlotsCount = entry.ChildIndices.Count(ci => ci != -1);
                
                // Count valid parent slots
                entry.ValidParentSlotsCount = entry.ParentIndices.Count(pi => pi != -1);
                
                // Check if Value points to a known address
                entry.ValueIsValidPointer = addressToRegularIdx.ContainsKey(entry.Value);
            }

            // Detect consecutive pointer runs (for pointer table detection)
            for (int i = 0; i < filteredRegularEntries.Count - 4; i++)
            {
                int consecutivePointers = 0;
                uint expectedAddr = filteredRegularEntries[i].Address;
                
                for (int j = i; j < Math.Min(i + 50, filteredRegularEntries.Count); j++)
                {
                    var entry = filteredRegularEntries[j];
                    if (entry.Address == expectedAddr && entry.ValueIsValidPointer)
                    {
                        consecutivePointers++;
                        expectedAddr += 4;  // Assuming 4-byte pointers
                    }
                    else break;
                }
                
                if (consecutivePointers >= 5)
                {
                    // Mark all entries in this run
                    for (int j = i; j < i + consecutivePointers; j++)
                    {
                        filteredRegularEntries[j].ConsecutivePointerRun = consecutivePointers;
                    }
                }
            }

            int totalForward = filteredRegularEntries.Sum(e => e.ReferenceCount.Forward);
            int totalBackward = filteredRegularEntries.Sum(e => e.ReferenceCount.Backward);

            // Debug output removed as per requirements

            return (filteredRegularEntries, consumedSeedsList, totalForward, totalBackward);
        }

        // Binary search helper for dedup list (sorted by Address)
        private static bool TryParseHex(string hexString, out uint result)
        {
            result = 0;
            if (string.IsNullOrWhiteSpace(hexString))
                return false;

            // Handle 0x prefix if present
            if (hexString.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
                hexString = hexString.Substring(2);

            return uint.TryParse(hexString, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out result);
        }

        private static int BinarySearchFirstIndexByAddress(List<(uint Address, uint RawValue, int LineIndex)> arr, uint target)
        {
            int lo = 0, hi = arr.Count - 1, res = arr.Count;
            while (lo <= hi)
            {
                int mid = (lo + hi) >> 1;
                if (arr[mid].Address >= target) { res = mid; hi = mid - 1; }
                else lo = mid + 1;
            }
            return res;
        }

        private string DetectPlatformKeyFromFileName(string path)
        {
            var name = Path.GetFileName(path) ?? "";
            
            // Check for DC platform first
            if (name.IndexOf("DC", StringComparison.OrdinalIgnoreCase) >= 0 && 
                BookOfVariables.Platforms.ContainsKey("DC"))
            {
                return "DC";
            }
            
            // Check other platforms
            foreach (var k in BookOfVariables.Platforms.Keys)
            {
                if (k.Equals("default", StringComparison.OrdinalIgnoreCase) || 
                    k.Equals("DC", StringComparison.OrdinalIgnoreCase)) 
                    continue;
                    
                if (name.IndexOf(k, StringComparison.OrdinalIgnoreCase) >= 0) 
                    return k;
            }
            return "default";
        }
    }
}