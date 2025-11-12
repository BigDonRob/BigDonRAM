using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace PointerAnalysis
{
    // Pure helpers and deterministic algorithms used by Computation orchestration.
    public static class ComputationHelpers
    {
        public class ComputationContext
        {
            public Computation.Config Config = null!;
            public List<Computation.AnalysisNode> Nodes = null!;
            public List<Ingestion.MemoryEntry> RegularEntries = null!;
            public StreamWriter? LogWriter = null;
            public Dictionary<uint, int> AddressToIndex = null!;

            public void Log(string s)
            {
                LogWriter?.WriteLine(s);
                if (Config.VerboseLogging) Console.WriteLine(s);
                LogWriter?.Flush();
            }
        }

        // Build deterministic chain following a single slot. Stop when encountering assigned nodes
        public static List<int> BuildChainFollowingSlot(ComputationContext ctx, int startIndex, int slotIndex, bool[] nodeAssigned)
        {
            var chain = new List<int>();
            var visited = new HashSet<int>();
            int cur = startIndex;
            int depth = 0;
            while (cur != -1 && depth < ctx.Config.MaxChainDepth)
            {
                if (nodeAssigned[cur] || ctx.Nodes[cur].WasAssignedToStructure) break;
                if (visited.Contains(cur)) break;
                visited.Add(cur);
                chain.Add(cur);
                int next = ctx.Nodes[cur].ChildSlotIndices[slotIndex];
                if (next == -1) break;
                cur = next;
                depth++;
            }
            return chain;
        }

        // Analyze a raw chain, trim heads depending on backlinks and seed flags, compute candidate stride and bridge gaps
        public static Computation.DetectedStructure? AnalyzeRawChain(ComputationContext ctx, List<int> rawChain, int slotIndex)
        {
            if (rawChain == null || rawChain.Count == 0) return null;
            var ds = new Computation.DetectedStructure { OffsetUsedToDetect = ctx.Config.SlotOffsets[slotIndex] };

            var chainSet = new HashSet<int>(rawChain);
            var localBacklinkSet = new HashSet<int>();
            foreach (var idx in rawChain)
            {
                for (int s = 0; s < ctx.Config.SlotOffsets.Length; s++)
                {
                    int parent = ctx.Nodes[idx].ParentSlotIndices[s];
                    if (parent != -1 && chainSet.Contains(parent)) { localBacklinkSet.Add(idx); break; }
                }
            }

            int firstBacklinkedPos = -1;
            for (int i = 0; i < rawChain.Count; i++) if (localBacklinkSet.Contains(rawChain[i])) { firstBacklinkedPos = i; break; }

            bool preservedContainsConsumedSeedTarget = rawChain.Any(g => g >= 0 && (ctx.RegularEntries[g].HasConsumedSelfSeed || ctx.RegularEntries[g].HasConsumedDoubleSeed));

            if (preservedContainsConsumedSeedTarget)
            {
                ds.OrderedGlobalNodeIndices.AddRange(rawChain);
                ds.TrimmedHeadCount = 0;
            }
            else
            {
                if (firstBacklinkedPos > 0)
                {
                    var trimmedHeads = rawChain.Take(firstBacklinkedPos).ToList();
                    var remainder = rawChain.Skip(firstBacklinkedPos).ToList();
                    
                    // Convert trimmed heads to entry points if they point into the remaining list
                    var addrToPos = new Dictionary<uint, int>();
                    for (int p = 0; p < remainder.Count; p++)
                    {
                        int g = remainder[p];
                        if (g >= 0) addrToPos[ctx.Nodes[g].Address] = p;
                    }

                    foreach (int headGlobal in trimmedHeads)
                    {
                        if (headGlobal < 0) continue;
                        
                        uint removedTarget = ctx.RegularEntries[headGlobal].Value;
                        int mappedPos = -1;
                        if (addrToPos.TryGetValue(removedTarget, out var pos)) 
                        {
                            mappedPos = pos;
                        }
                        else
                        {
                            // Find the closest position if no exact match
                            long best = long.MaxValue; 
                            int bestP = -1;
                            for (int p = 0; p < remainder.Count; p++)
                            {
                                int g = remainder[p];
                                if (g < 0) continue;
                                long diff = Math.Abs((long)ctx.Nodes[g].Address - (long)removedTarget);
                                if (diff < best) { best = diff; bestP = p; }
                            }
                            if (bestP != -1) mappedPos = bestP;
                        }

                        if (mappedPos >= 0)
                        {
                            var ep = new Computation.EntryPoint
                            {
                                SourceGlobalNodeIndex = headGlobal,
                                TargetPositionZeroBased = mappedPos,
                                OffsetAtWhichSourcePoints = ds.OffsetUsedToDetect,
                                SourceWasFromOtherStructure = ctx.Nodes[headGlobal].WasAssignedToStructure
                            };
                            if (!ds.ExternalEntryPointsByOffset.ContainsKey(ds.OffsetUsedToDetect)) 
                                ds.ExternalEntryPointsByOffset[ds.OffsetUsedToDetect] = new List<Computation.EntryPoint>();
                            ds.ExternalEntryPointsByOffset[ds.OffsetUsedToDetect].Add(ep);
                        }
                    }
                    
                    ds.OrderedGlobalNodeIndices.AddRange(remainder);
                    ds.TrimmedHeadCount = firstBacklinkedPos;
                }
                else
                {
                    ds.OrderedGlobalNodeIndices.AddRange(rawChain);
                    ds.TrimmedHeadCount = 0;
                }
            }

            if (ds.OrderedGlobalNodeIndices.Count < 2) return null;

            var strideList = new List<long>();
            for (int i = 0; i < ds.OrderedGlobalNodeIndices.Count - 1; i++)
            {
                int g = ds.OrderedGlobalNodeIndices[i];
                if (g < 0) continue;
                strideList.Add(ctx.Nodes[g].Stride);
            }

            if (strideList.Count > 0)
            {
                var freq = new Dictionary<long, int>();
                foreach (var st in strideList) { if (!freq.ContainsKey(st)) freq[st] = 0; freq[st]++; }
                var best = freq.OrderByDescending(kv => kv.Value).First();
                if ((double)best.Value / strideList.Count >= ctx.Config.DominantStrideRatio)
                {
                    ds.CommonStride = (uint)best.Key;
                    ds.CommonStrideOccurrences = best.Value;
                }
            }

            ds.MissingPlaceholderCount = BridgeGapsByStride(ctx, ds);
            return ds;
        }

        // Bridge small exact-multiple gaps by inserting -1 placeholders if within limits
        public static int BridgeGapsByStride(ComputationContext ctx, Computation.DetectedStructure ds)
        {
            if (ds.CommonStride == null) return 0;
            long stride = (long)ds.CommonStride.Value;
            if (stride <= 0) return 0;

            int insertedTotal = 0;
            int i = 0;
            while (i + 1 < ds.OrderedGlobalNodeIndices.Count)
            {
                int a = ds.OrderedGlobalNodeIndices[i];
                int b = ds.OrderedGlobalNodeIndices[i + 1];
                if (a == -1 || b == -1) { i++; continue; }
                long addrA = (long)ctx.Nodes[a].Address;
                long addrB = (long)ctx.Nodes[b].Address;
                long gap = addrB - addrA;
                if (gap <= 0) { i++; continue; }
                if (gap == stride) { i++; continue; }
                if (gap % stride == 0)
                {
                    long steps = gap / stride;
                    int missing = (int)steps - 1;
                    if (missing > 0 && missing <= ctx.Config.MaxMissingPerGap)
                    {
                        if (insertedTotal + missing > ctx.Config.MaxMissingPerList) break;
                        int insertPos = i + 1;
                        for (int k = 0; k < missing; k++) ds.OrderedGlobalNodeIndices.Insert(insertPos + k, -1);
                        insertedTotal += missing;
                        i = insertPos + missing;
                        continue;
                    }
                }
                i++;
            }
            return insertedTotal;
        }

        // Detect circular closure by following child links for the offset slot
        public static bool DetectCircularity(ComputationContext ctx, Computation.DetectedStructure ds)
        {
            var preservedIndices = ds.OrderedGlobalNodeIndices.Where(n => n >= 0).ToList();
            if (preservedIndices.Count == 0) return false;

            int slotIndex = Array.IndexOf(ctx.Config.SlotOffsets, ds.OffsetUsedToDetect);
            if (slotIndex < 0) slotIndex = 0;

            int startNode = preservedIndices[0];
            var visited = new HashSet<int>();
            int cur = startNode;
            int steps = 0;
            while (cur != -1 && steps < (ds.OrderedGlobalNodeIndices.Count * 2))
            {
                if (visited.Contains(cur)) break;
                visited.Add(cur);
                int next = ctx.Nodes[cur].ChildSlotIndices[slotIndex];
                if (next == -1) return false;
                cur = next;
                steps++;
            }

            if (cur == startNode && visited.Count >= preservedIndices.Count)
            {
                ctx.Log($"Circularity detected for offset 0x{ds.OffsetUsedToDetect:X}: visited={visited.Count} preserved={preservedIndices.Count}");
                return true;
            }
            return false;
        }

        // Check for doubly-linked list using the HasConsumedSelfSeed and HasConsumedDoubleSeed flags
        // and trim the chain based on backlink flags
        public static bool ComputeDoublyLinkedness(ComputationContext ctx, Computation.DetectedStructure ds)
        {
            if (ds.OrderedGlobalNodeIndices.Count == 0) return false;
            
            bool hasDoubleReference = false;
            bool hasSelfReference = false;
            int firstGoodIndex = -1;
            int lastGoodIndex = -1;
            int lastDoubleLinkIndex = -1;

            // First pass: check the type of list and find valid nodes
            for (int i = 0; i < ds.OrderedGlobalNodeIndices.Count; i++)
            {
                int nodeIndex = ds.OrderedGlobalNodeIndices[i];
                if (nodeIndex < 0) continue;
                
                var entry = ctx.RegularEntries[nodeIndex];
                
                // Check for double reference (takes precedence)
                if (entry.HasConsumedDoubleSeed)
                {
                    hasDoubleReference = true;
                    lastDoubleLinkIndex = i;
                    
                    // For the last node in the list, we don't expect a double link
                    bool isLastNode = (i == ds.OrderedGlobalNodeIndices.Count - 1);
                    if (!isLastNode || entry.HasConsumedDoubleSeed)
                    {
                        if (firstGoodIndex == -1) firstGoodIndex = i;
                        lastGoodIndex = i;
                    }
                }
                // Check for self reference (only if we haven't found any double references)
                else if (!hasDoubleReference && entry.HasConsumedSelfSeed)
                {
                    hasSelfReference = true;
                    if (firstGoodIndex == -1) firstGoodIndex = i;
                    lastGoodIndex = i;
                }
            }
            
            // If we found double references, ensure we have at least two nodes with double links
            // (except for the last node which is allowed to not have a double link)
            if (hasDoubleReference)
            {
                int doubleLinkCount = 0;
                // Count double links, excluding the last node
                for (int i = 0; i < ds.OrderedGlobalNodeIndices.Count - 1; i++)
                {
                    int nodeIndex = ds.OrderedGlobalNodeIndices[i];
                    if (nodeIndex >= 0 && ctx.RegularEntries[nodeIndex].HasConsumedDoubleSeed)
                    {
                        doubleLinkCount++;
                    }
                }
                
                // Need at least two double links (or one if list is length 2)
                if (doubleLinkCount < 1 || (ds.OrderedGlobalNodeIndices.Count > 2 && doubleLinkCount < 2))
                {
                    hasDoubleReference = false;
                    // Fall back to checking for self-references
                    firstGoodIndex = -1;
                    lastGoodIndex = -1;
                    for (int i = 0; i < ds.OrderedGlobalNodeIndices.Count; i++)
                    {
                        int nodeIndex = ds.OrderedGlobalNodeIndices[i];
                        if (nodeIndex >= 0 && ctx.RegularEntries[nodeIndex].HasConsumedSelfSeed)
                        {
                            hasSelfReference = true;
                            if (firstGoodIndex == -1) firstGoodIndex = i;
                            lastGoodIndex = i;
                        }
                    }
                }
            }
            
            // Trim the chain to the last good node
            if (lastGoodIndex >= 0 && lastGoodIndex < ds.OrderedGlobalNodeIndices.Count - 1)
            {
                int trimCount = ds.OrderedGlobalNodeIndices.Count - (lastGoodIndex + 1);
                if (trimCount > 0)
                {
                    ds.OrderedGlobalNodeIndices.RemoveRange(lastGoodIndex + 1, trimCount);
                }
            }
            
            // Only trim heads if we're certain they're not part of the list
            // For a valid list, the head node might not have a backlink, so we need to be careful
            if (firstGoodIndex > 0)
            {
                bool shouldTrim = false;
                
                // Check if the first node is actually part of the list
                if (ds.OrderedGlobalNodeIndices.Count > 1)
                {
                    int firstNode = ds.OrderedGlobalNodeIndices[0];
                    int secondNode = ds.OrderedGlobalNodeIndices[1];
                    
                    if (firstNode >= 0 && secondNode >= 0)
                    {
                        var firstEntry = ctx.RegularEntries[firstNode];
                        var secondAddr = ctx.RegularEntries[secondNode].Address;
                        
                        // Only trim if the first node doesn't point to the second node
                        // and isn't pointed to by any node in the list
                        bool pointsToNext = firstEntry.ChildIndices.Any(ci => 
                            ci >= 0 && ci < ctx.RegularEntries.Count && 
                            ctx.RegularEntries[ci].Address == secondAddr);
                            
                        bool isPointedTo = false;
                        for (int i = 1; i < ds.OrderedGlobalNodeIndices.Count; i++)
                        {
                            int nodeIdx = ds.OrderedGlobalNodeIndices[i];
                            if (nodeIdx < 0) continue;
                            
                            var node = ctx.RegularEntries[nodeIdx];
                            if (node.ChildIndices.Any(ci => 
                                ci >= 0 && ci < ctx.RegularEntries.Count && 
                                ctx.RegularEntries[ci].Address == firstEntry.Address))
                            {
                                isPointedTo = true;
                                break;
                            }
                        }
                        
                        shouldTrim = !pointsToNext && !isPointedTo;
                    }
                }
                
                if (shouldTrim)
                {
                    // Don't trim if it would remove all nodes
                    if (firstGoodIndex < ds.OrderedGlobalNodeIndices.Count && firstGoodIndex > 0)
                    {
                        var trimmedHeads = ds.OrderedGlobalNodeIndices.Take(firstGoodIndex).ToList();
                        
                        // Convert trimmed heads to entry points if they point into the remaining list
                        var addrToPos = new Dictionary<uint, int>();
                        for (int p = firstGoodIndex; p < ds.OrderedGlobalNodeIndices.Count; p++)
                        {
                            int g = ds.OrderedGlobalNodeIndices[p];
                            if (g >= 0) addrToPos[ctx.Nodes[g].Address] = p - firstGoodIndex;
                        }

                        foreach (int headGlobal in trimmedHeads)
                        {
                            if (headGlobal < 0) continue;
                            
                            uint removedTarget = ctx.RegularEntries[headGlobal].Value;
                            int mappedPos = -1;
                            if (addrToPos.TryGetValue(removedTarget, out var pos)) 
                            {
                                mappedPos = pos;
                            }
                            else
                            {
                                // Find the closest position if no exact match
                                long best = long.MaxValue; 
                                int bestP = -1;
                                for (int p = firstGoodIndex; p < ds.OrderedGlobalNodeIndices.Count; p++)
                                {
                                    int g = ds.OrderedGlobalNodeIndices[p];
                                    if (g < 0) continue;
                                    long diff = Math.Abs((long)ctx.Nodes[g].Address - (long)removedTarget);
                                    if (diff < best) { best = diff; bestP = p - firstGoodIndex; }
                                }
                                if (bestP != -1) mappedPos = bestP;
                            }

                            if (mappedPos >= 0)
                            {
                                var ep = new Computation.EntryPoint
                                {
                                    SourceGlobalNodeIndex = headGlobal,
                                    TargetPositionZeroBased = mappedPos,
                                    OffsetAtWhichSourcePoints = ds.OffsetUsedToDetect,
                                    SourceWasFromOtherStructure = ctx.Nodes[headGlobal].WasAssignedToStructure
                                };
                                if (!ds.ExternalEntryPointsByOffset.ContainsKey(ds.OffsetUsedToDetect)) 
                                    ds.ExternalEntryPointsByOffset[ds.OffsetUsedToDetect] = new List<Computation.EntryPoint>();
                                ds.ExternalEntryPointsByOffset[ds.OffsetUsedToDetect].Add(ep);
                            }
                        }
                        
                        ds.OrderedGlobalNodeIndices.RemoveRange(0, firstGoodIndex);
                        ds.TrimmedHeadCount = firstGoodIndex;
                    }
                }
                else
                {
                    // If we're not trimming, reset the trimmed count
                    ds.TrimmedHeadCount = 0;
                }
            }
            
            // If we found double references, it's a doubly-linked list
            if (hasDoubleReference) return true;
            
            // If we found self references, it's a singly-linked list with back pointers
            if (hasSelfReference) return false;
            
            // If we get here, no valid backlinks were found
            return false;
        }

        // Trim head nodes that don't match dominant stride; convert removed heads to external entry points (if mappable)
        public static List<int> TrimLeadingNodesNotMatchingDominantStride(ComputationContext ctx, Computation.DetectedStructure ds)
        {
            var removed = new List<int>();
            if (ds.CommonStride == null) return removed;
            long dominant = (long)ds.CommonStride.Value;
            if (dominant == 0) return removed;

            var addrToPos = new Dictionary<uint, int>();
            for (int p = 0; p < ds.OrderedGlobalNodeIndices.Count; p++)
            {
                int g = ds.OrderedGlobalNodeIndices[p];
                if (g >= 0) addrToPos[ctx.Nodes[g].Address] = p;
            }

            while (ds.OrderedGlobalNodeIndices.Count > 0 && ds.OrderedGlobalNodeIndices.Count - removed.Count >= ctx.Config.MinListLength)
            {
                int headPos = 0;
                int headGlobal = ds.OrderedGlobalNodeIndices[headPos];
                if (headGlobal < 0) break;
                if (ctx.RegularEntries[headGlobal].HasConsumedSelfSeed || ctx.RegularEntries[headGlobal].HasConsumedDoubleSeed) break;

                int nextPos = headPos + 1;
                while (nextPos < ds.OrderedGlobalNodeIndices.Count && ds.OrderedGlobalNodeIndices[nextPos] == -1) nextPos++;
                if (nextPos >= ds.OrderedGlobalNodeIndices.Count) break;
                int nextGlobal = ds.OrderedGlobalNodeIndices[nextPos];
                if (nextGlobal < 0) break;
                long observed = (long)ctx.Nodes[nextGlobal].Address - (long)ctx.Nodes[headGlobal].Address;
                if (Math.Abs(observed - dominant) == 0) break;

                removed.Add(headGlobal);
                ds.OrderedGlobalNodeIndices.RemoveAt(headPos);

                uint removedTarget = ctx.RegularEntries[headGlobal].Value;
                int mappedPos = -1;
                if (addrToPos.TryGetValue(removedTarget, out var pos)) mappedPos = pos;
                else
                {
                    long best = long.MaxValue; int bestP = -1;
                    for (int p = 0; p < ds.OrderedGlobalNodeIndices.Count; p++)
                    {
                        int g = ds.OrderedGlobalNodeIndices[p];
                        if (g < 0) continue;
                        long diff = Math.Abs((long)ctx.Nodes[g].Address - (long)removedTarget);
                        if (diff < best) { best = diff; bestP = p; }
                    }
                    if (bestP != -1) mappedPos = bestP;
                }

                if (mappedPos >= 0)
                {
                    var ep = new Computation.EntryPoint
                    {
                        SourceGlobalNodeIndex = headGlobal,
                        TargetPositionZeroBased = mappedPos,
                        OffsetAtWhichSourcePoints = ds.OffsetUsedToDetect,
                        SourceWasFromOtherStructure = ctx.Nodes[headGlobal].WasAssignedToStructure
                    };
                    if (!ds.ExternalEntryPointsByOffset.ContainsKey(ds.OffsetUsedToDetect)) 
                        ds.ExternalEntryPointsByOffset[ds.OffsetUsedToDetect] = new List<Computation.EntryPoint>();
                    ds.ExternalEntryPointsByOffset[ds.OffsetUsedToDetect].Add(ep);
                }
            }

            return removed;
        }

        // Recompute the most common stride in the structure
        public static void RecomputeCommonStride(ComputationContext ctx, Computation.DetectedStructure ds)
        {
            var strides = new List<long>();
            for (int i = 0; i < ds.OrderedGlobalNodeIndices.Count - 1; i++)
            {
                int g = ds.OrderedGlobalNodeIndices[i];
                if (g < 0) continue;
                strides.Add(ctx.Nodes[g].Stride);
            }
            if (strides.Count == 0) { ds.CommonStride = null; return; }
            var freq = new Dictionary<long, int>();
            foreach (var st in strides) { if (!freq.ContainsKey(st)) freq[st] = 0; freq[st]++; }
            var best = freq.OrderByDescending(kv => kv.Value).First();
            if ((double)best.Value / strides.Count >= ctx.Config.DominantStrideRatio) 
                { ds.CommonStride = (uint)best.Key; ds.CommonStrideOccurrences = best.Value; }
            else ds.CommonStride = null;
        }

        // Collect external entry points only (sources not in preserved set), applying upstream chain discard rule
        public static void CollectGlobalEntryPointsWithChainFilter(ComputationContext ctx, Computation.DetectedStructure ds, bool[] nodeAssigned)
        {
            // Skip entry point collection for lists longer than the maximum allowed length
            // (0 means no limit)
            if (BookOfVariables.MaxListLengthForEntryPoints > 0 && 
                ds.OrderedGlobalNodeIndices.Count > BookOfVariables.MaxListLengthForEntryPoints)
            {
                ctx.Log($"Skipping entry point collection for list of length {ds.OrderedGlobalNodeIndices.Count} (exceeds max {BookOfVariables.MaxListLengthForEntryPoints})");
                return;
            }

            var addrToPos = new Dictionary<uint, int>();
            var preservedSet = new HashSet<int>();
            for (int p = 0; p < ds.OrderedGlobalNodeIndices.Count; p++)
            {
                int g = ds.OrderedGlobalNodeIndices[p];
                if (g >= 0) { addrToPos[ctx.Nodes[g].Address] = p; preservedSet.Add(g); }
            }

            var found = new List<Computation.EntryPoint>();
            int slotIndex = Array.IndexOf(ctx.Config.SlotOffsets, ds.OffsetUsedToDetect);
            if (slotIndex < 0) slotIndex = 0;

            int externalCandidates = 0, internalSkipped = 0, discardedByChain = 0;
            // First, check all nodes that might point into our list
            for (int src = 0; src < ctx.Nodes.Count; src++)
            {
                if (preservedSet.Contains(src) || nodeAssigned[src] || ctx.Nodes[src].WasAssignedToStructure) 
                    { internalSkipped++; continue; }

                // Skip direct pointer checks as they don't have an offset to match

                // Only check the child slot that matches the list's offset
                var node = ctx.Nodes[src];
                if (slotIndex >= 0 && slotIndex < node.ChildSlotIndices.Length)
                {
                    int childIdx = node.ChildSlotIndices[slotIndex];
                    if (childIdx >= 0 && childIdx < ctx.Nodes.Count)
                    {
                        uint childTarget = ctx.Nodes[childIdx].Address;
                        if (addrToPos.TryGetValue(childTarget, out int pos))
                        {
                            int chainLen = BackwardParentChainLength(ctx, src, slotIndex, ctx.Config.EntryBackwardDepthLimit);
                            if (chainLen <= ctx.Config.EntryChainDiscardThreshold)
                            {
                                externalCandidates++;
                                found.Add(new Computation.EntryPoint
                                {
                                    SourceGlobalNodeIndex = src,
                                    TargetPositionZeroBased = pos,
                                    OffsetAtWhichSourcePoints = ds.OffsetUsedToDetect,
                                    SourceWasFromOtherStructure = ctx.Nodes[src].WasAssignedToStructure
                                });
                            }
                            else
                            {
                                discardedByChain++;
                            }
                        }
                    }
                }
            }

            if (found.Count > 0) ds.ExternalEntryPointsByOffset[ds.OffsetUsedToDetect] = found;
            ctx.Log($"Entry discovery offset=0x{ds.OffsetUsedToDetect:X}: externalCandidates={externalCandidates} internalSkipped={internalSkipped} discardedByChain={discardedByChain} reported={found.Count}");
        }

        // Upstream chain length along parent slots
        public static int BackwardParentChainLength(ComputationContext ctx, int startSrc, int slotIndex, int limit)
        {
            int len = 0;
            int cur = startSrc;
            var visited = new HashSet<int>();
            while (cur != -1 && len < limit)
            {
                if (visited.Contains(cur)) break;
                visited.Add(cur);
                int parent = ctx.Nodes[cur].ParentSlotIndices[slotIndex];
                if (parent == -1) break;
                cur = parent;
                len++;
            }
            return len;
        }
    }
}
