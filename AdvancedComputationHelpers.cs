using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace PointerAnalysis
{
    public static class AdvancedComputationHelpers
    {
        public class AdvancedContext
        {
            public AdvancedComputation.Config Config = null!;
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

        // Binary Tree Detection
        public static List<AdvancedComputation.BinaryTree> DetectBinaryTrees(AdvancedContext ctx, bool[] nodeAssigned)
        {
            var trees = new List<AdvancedComputation.BinaryTree>();
            var visited = new HashSet<int>();

            // Find potential roots (nodes with 2+ children and no parents)
            for (int i = 0; i < ctx.Nodes.Count; i++)
            {
                if (nodeAssigned[i]) continue;  // Skip nodes already assigned to other structures

                var entry = ctx.RegularEntries[i];
                if (entry.ValidChildSlotsCount >= 2 && entry.ValidParentSlotsCount == 0)
                {
                    // Found a potential root (has multiple children, no parents)
                    var tree = BuildTreeFromRoot(ctx, i, nodeAssigned);
                    tree.RootNodeIndex = i;
                    tree.IsBalanced = CheckTreeBalance(ctx, tree);
                    
                    // Apply minimum size/depth based on verbose logging
                    bool meetsSizeCriteria = ctx.Config.VerboseLogging 
                        ? tree.NodeIndices.Count >= ctx.Config.MinTreeSize
                        : tree.NodeIndices.Count >= ctx.Config.MinTreeSize && 
                          tree.MaxDepth >= BookOfVariables.MinTreeDepthNonVerbose;
                    
                    if (meetsSizeCriteria)
                    {
                        trees.Add(tree);
                        // Mark nodes as assigned
                        foreach (var nodeIdx in tree.NodeIndices)
                        {
                            nodeAssigned[nodeIdx] = true;
                        }
                    }
                }
            }

            return trees;
        }

        private static AdvancedComputation.BinaryTree BuildTreeFromRoot(AdvancedContext ctx, int rootIndex, bool[] nodeAssigned)
        {
            var tree = new AdvancedComputation.BinaryTree();
            var queue = new Queue<(int nodeIndex, int depth)>();
            var visited = new HashSet<int>();

            queue.Enqueue((rootIndex, 0));
            visited.Add(rootIndex);

            // Try to find left/right child slots (most common case)
            int leftSlot = -1, rightSlot = -1;
            var entry = ctx.RegularEntries[rootIndex];

            // Find the first two valid child slots to use as left/right
            for (int i = 0; i < entry.ChildIndices.Length; i++)
            {
                if (entry.ChildIndices[i] != -1)
                {
                    if (leftSlot == -1) leftSlot = i;
                    else if (rightSlot == -1) rightSlot = i;
                    else break;
                }
            }

            tree.LeftSlotOffset = leftSlot;
            tree.RightSlotOffset = rightSlot;

            int bfsCount = 0;
            // BFS traversal
            while (queue.Count > 0)
            {
                var (currentIdx, depth) = queue.Dequeue();

                // Safety cap to avoid runaway BFS
                bfsCount++;
                if (bfsCount > ctx.Config.MaxBfsNodes)
                {
                    ctx.Log($"BFS reached max nodes ({ctx.Config.MaxBfsNodes}). Stopping further traversal for root {rootIndex}.");
                    break;
                }

                tree.NodeIndices.Add(currentIdx);
                tree.MaxDepth = Math.Max(tree.MaxDepth, depth);

                if (depth >= ctx.Config.MaxTreeDepth) continue;  // Prevent runaway depth

                // Enqueue left and right children if they exist
                var currentEntry = ctx.RegularEntries[currentIdx];

                if (leftSlot != -1 && leftSlot < currentEntry.ChildIndices.Length)
                {
                    int leftChild = currentEntry.ChildIndices[leftSlot];
                    if (leftChild != -1 && !visited.Contains(leftChild) && !nodeAssigned[leftChild])
                    {
                        visited.Add(leftChild);
                        queue.Enqueue((leftChild, depth + 1));
                    }
                }

                if (rightSlot != -1 && rightSlot < currentEntry.ChildIndices.Length)
                {
                    int rightChild = currentEntry.ChildIndices[rightSlot];
                    if (rightChild != -1 && !visited.Contains(rightChild) && !nodeAssigned[rightChild])
                    {
                        visited.Add(rightChild);
                        queue.Enqueue((rightChild, depth + 1));
                    }
                }
            }

            return tree;
        }

        private static bool CheckTreeBalance(AdvancedContext ctx, AdvancedComputation.BinaryTree tree)
        {
            // A tree is balanced if the depth of any two leaves differs by at most 1
            if (tree.NodeIndices.Count <= 2) return true;

            var depths = new List<int>();

            // Simple DFS to find all leaf depths
            void Dfs(int nodeIdx, int depth, HashSet<int> visited)
            {
                if (visited.Contains(nodeIdx)) return;
                visited.Add(nodeIdx);

                var entry = ctx.RegularEntries[nodeIdx];
                bool isLeaf = true;

                // Check left and right children
                if (tree.LeftSlotOffset != -1 && tree.LeftSlotOffset < entry.ChildIndices.Length &&
                    entry.ChildIndices[tree.LeftSlotOffset] != -1)
                {
                    isLeaf = false;
                    Dfs(entry.ChildIndices[tree.LeftSlotOffset], depth + 1, visited);
                }

                if (tree.RightSlotOffset != -1 && tree.RightSlotOffset < entry.ChildIndices.Length &&
                    entry.ChildIndices[tree.RightSlotOffset] != -1)
                {
                    isLeaf = false;
                    Dfs(entry.ChildIndices[tree.RightSlotOffset], depth + 1, visited);
                }

                if (isLeaf)
                {
                    depths.Add(depth);
                }
            }

            var visited = new HashSet<int>();
            Dfs(tree.RootNodeIndex, 0, visited);

            if (depths.Count == 0) return false;

            int minDepth = depths.Min();
            int maxDepth = depths.Max();

            return (maxDepth - minDepth) <= 1;
        }

        // Pointer Table Detection
        public static List<AdvancedComputation.PointerTable> DetectPointerTables(AdvancedContext ctx, bool[] nodeAssigned)
        {
            var tables = new List<AdvancedComputation.PointerTable>();
            var processed = new HashSet<int>();

            // Group nodes by their ConsecutivePointerRun value (>= MinTableSize)
            var pointerRuns = new Dictionary<int, List<int>>();

            for (int i = 0; i < ctx.RegularEntries.Count; i++)
            {
                if (nodeAssigned[i]) continue;

                int runLength = ctx.RegularEntries[i].ConsecutivePointerRun;
                if (runLength >= ctx.Config.MinTableSize)
                {
                    if (!pointerRuns.ContainsKey(runLength))
                        pointerRuns[runLength] = new List<int>();
                    pointerRuns[runLength].Add(i);
                }
            }

            // Process each run length
            foreach (var kvp in pointerRuns)
            {
                int runLength = kvp.Key;
                var indices = kvp.Value;

                // Sort by address to find consecutive runs (one-time sort per run length)
                indices.Sort((a, b) => ctx.RegularEntries[a].Address.CompareTo(ctx.RegularEntries[b].Address));

                // Find consecutive runs of the same length
                for (int i = 0; i < indices.Count; )
                {
                    int startIdx = indices[i];
                    uint expectedNextAddr = ctx.RegularEntries[startIdx].Address + 4;  // 4 bytes per pointer
                    int count = 1;

                    // Safety cap for inner scan to prevent extreme loops
                    int innerScan = 0;
                    while (i + count < indices.Count &&
                           innerScan < ctx.Config.MaxTableRunScan &&
                           ctx.RegularEntries[indices[i + count]].Address == expectedNextAddr &&
                           count < runLength)
                    {
                        expectedNextAddr += 4;
                        count++;
                        innerScan++;
                    }

                    if (innerScan >= ctx.Config.MaxTableRunScan)
                    {
                        ctx.Log($"Pointer table scan hit max scan {ctx.Config.MaxTableRunScan} at index {i}. Aborting this run.");
                    }

                    // If we found a complete or substantial run
                    if (count >= ctx.Config.MinTableSize)
                    {
                        var table = new AdvancedComputation.PointerTable
                        {
                            StartAddress = ctx.RegularEntries[indices[i]].Address,
                            EndAddress = ctx.RegularEntries[indices[i + count - 1]].Address + 4,  // Exclusive
                            Length = count,
                        };

                        // Add nodes and target addresses
                        for (int j = 0; j < count; j++)
                        {
                            int idx = indices[i + j];
                            table.NodeIndices.Add(idx);
                            table.TargetAddresses.Add(ctx.RegularEntries[idx].Value);
                            processed.Add(idx);
                        }

                        // Check if all targets are the same value (likely uninitialized memory or sentinel)
                        bool allSameValue = table.TargetAddresses.All(addr => addr == table.TargetAddresses[0]);
                        bool allSentinels = table.TargetAddresses.All(addr => IsLikelySentinel(addr));
                        int mostlySameOrSentinelsCount = table.TargetAddresses.Count(addr =>
                            addr == table.TargetAddresses[0] || IsLikelySentinel(addr));
                        bool mostlySameOrSentinels = mostlySameOrSentinelsCount > table.TargetAddresses.Count * 0.8;

                        if (allSameValue || allSentinels || mostlySameOrSentinels)
                        {
                            string reason = allSameValue
                                ? $"all pointers point to same address 0x{table.TargetAddresses[0]:X8}"
                                : allSentinels
                                    ? "all pointers point to likely sentinel values"
                                    : "more than 80% of pointers are identical or sentinel values";

                            ctx.Log($"Skipping table at 0x{table.StartAddress:X8} - {reason}");

                            // Mark nodes as assigned to avoid reprocessing
                            foreach (var nodeIdx in table.NodeIndices)
                            {
                                nodeAssigned[nodeIdx] = true;
                            }
                        }
                        else
                        {
                            // Cache distinct count to avoid repeated enumeration
                            int distinctCount = table.TargetAddresses.Distinct().Count();

                            // Additional check for common patterns that might not be useful
                            if (distinctCount <= 2)
                            {
                                ctx.Log($"Skipping table at 0x{table.StartAddress:X8} - only {distinctCount} unique target addresses");
                                foreach (var nodeIdx in table.NodeIndices)
                                {
                                    nodeAssigned[nodeIdx] = true;
                                }
                            }
                            else
                            {
                                // Check if all targets are of similar type
                                table.AllTargetsSameType = CheckTargetSimilarity(ctx, table);

                                // Only add if the targets are sufficiently diverse and similar in structure
                                if (table.AllTargetsSameType && distinctCount >= 3)
                                {
                                    bool meetsSizeCriteria = ctx.Config.VerboseLogging
                                        ? table.Length >= ctx.Config.MinTableSize
                                        : table.Length >= BookOfVariables.MinTableElementsNonVerbose;

                                    if (meetsSizeCriteria)
                                    {
                                        tables.Add(table);

                                        // Mark nodes as assigned
                                        foreach (var nodeIdx in table.NodeIndices)
                                        {
                                            nodeAssigned[nodeIdx] = true;
                                        }
                                    }
                                }
                                else
                                {
                                    ctx.Log($"Skipping table at 0x{table.StartAddress:X8} - insufficient target diversity or structural similarity");
                                    foreach (var nodeIdx in table.NodeIndices)
                                    {
                                        nodeAssigned[nodeIdx] = true;
                                    }
                                }
                            }
                        }
                    }

                    // Ensure we always advance i by at least 1 to avoid infinite loops
                    i += Math.Max(1, count);
                }
            }

            return tables;
        }

        private static bool CheckTargetSimilarity(AdvancedContext ctx, AdvancedComputation.PointerTable table)
        {
            if (table.TargetAddresses.Count < 2) return true;

            // Find first valid target to use as reference
            int firstValidIdx = -1;
            for (int i = 0; i < table.TargetAddresses.Count; i++)
            {
                if (ctx.AddressToIndex.TryGetValue(table.TargetAddresses[i], out int idx))
                {
                    firstValidIdx = i;
                    break;
                }
            }

            // If no valid targets, this isn't a valid table
            if (firstValidIdx == -1)
            {
                ctx.Log($"Skipping table at 0x{table.StartAddress:X8} - no valid target addresses");
                return false;
            }

            var firstEntry = ctx.RegularEntries[ctx.AddressToIndex[table.TargetAddresses[firstValidIdx]]];
            int similarCount = 1;
            int validTargets = 1;

            for (int i = 0; i < table.TargetAddresses.Count; i++)
            {
                if (i == firstValidIdx) continue; // Skip the reference target

                if (!ctx.AddressToIndex.TryGetValue(table.TargetAddresses[i], out int targetIdx))
                    continue;

                validTargets++;
                var entry = ctx.RegularEntries[targetIdx];

                // Check if the structure is similar to the first valid one
                if (Math.Abs(entry.ValidChildSlotsCount - firstEntry.ValidChildSlotsCount) <= 1 &&
                    Math.Abs(entry.ValidParentSlotsCount - firstEntry.ValidParentSlotsCount) <= 1)
                {
                    similarCount++;
                }
            }

            // Need at least 2 valid targets to make a comparison
            if (validTargets < 2)
            {
                ctx.Log($"Skipping table at 0x{table.StartAddress:X8} - not enough valid targets for comparison");
                return false;
            }

            // Consider it a valid table if at least 80% of valid targets are similar
            bool isSimilar = (float)similarCount / validTargets >= 0.8f;

            if (!isSimilar)
            {
                ctx.Log($"Skipping table at 0x{table.StartAddress:X8} - only {similarCount} of {validTargets} valid targets have similar structure");
            }

            return isSimilar;
        }

        private static bool IsLikelySentinel(uint address)
        {
            // Common sentinel values that might indicate uninitialized memory
            return address == 0x00008000 ||  // Common in some game engines
                   address == 0xCDCDCDCD ||  // Microsoft debug fill
                   address == 0xDDDDDDDD ||  // Microsoft freed memory
                   address == 0xFEEEFEEE ||  // Microsoft no man's land
                   address == 0xABABABAB ||  // Microsoft heap free
                   address == 0xBAADF00D;    // Microsoft bad food (uninitialized heap memory)
        }

        // Structure Array Detection
        public static List<AdvancedComputation.StructureArray> DetectStructureArrays(AdvancedContext ctx, bool[] nodeAssigned)
        {
            var arrays = new List<AdvancedComputation.StructureArray>();
            var processed = new HashSet<int>();
            var potentialArrays = new List<AdvancedComputation.StructureArray>();

            int nodeLimit = Math.Min(ctx.RegularEntries.Count, ctx.Config.MaxNodesToProcessForArrays);
            // Sort nodes by address once, up-front
            var sortedNodes = Enumerable.Range(0, nodeLimit)
                .Where(i => !nodeAssigned[i])
                .OrderBy(i => ctx.RegularEntries[i].Address)
                .ToList();

            if (sortedNodes.Count == 0)
            {
                return arrays;
            }

            // First pass: find all potential arrays (bounded by MaxArraysToDetect)
            int maxArraysToDetect = ctx.Config.MaxArraysToDetect;
            for (int i = 0; i < sortedNodes.Count - ctx.Config.MinArraySize && potentialArrays.Count < maxArraysToDetect; )
            {
                int startIdx = sortedNodes[i];
                if (nodeAssigned[startIdx] || processed.Contains(startIdx))
                {
                    i++;
                    continue;
                }

                // Limit the search window to prevent excessive processing
                int searchWindow = Math.Min(1000, sortedNodes.Count - i);
                var searchNodes = sortedNodes.Skip(i).Take(searchWindow).ToList();

                // Look for a sequence of nodes with consistent stride
                var array = BuildStructureArray(ctx, searchNodes, 0, nodeAssigned);

                if (array != null && array.Length >= ctx.Config.MinArraySize)
                {
                    // Skip if this would create a duplicate or overlapping array
                    bool isDuplicate = potentialArrays.Any(a =>
                        a.StartAddress <= array.EndAddress &&
                        a.EndAddress >= array.StartAddress);

                    if (!isDuplicate)
                    {
                        potentialArrays.Add(array);

                        // Mark nodes as processed for this pass
                        foreach (var nodeIdx in array.NodeIndices)
                        {
                            processed.Add(nodeIdx);
                        }
                    }
                }

                // Ensure i always advances at least by 1 (fixes previous infinite-loop risk)
                int skip = Math.Max(1, array?.NodeIndices.Count ?? 1);
                i += skip;
            }

            // If we didn't find any potential arrays, return empty list
            if (potentialArrays.Count == 0)
            {
                return arrays;
            }

            // Sort potential arrays by start address
            potentialArrays.Sort((a, b) => a.StartAddress.CompareTo(b.StartAddress));

            // Group arrays that are part of the same structure
            var structureGroups = new List<List<AdvancedComputation.StructureArray>>();
            var currentGroup = new List<AdvancedComputation.StructureArray> { potentialArrays[0] };

            for (int i = 1; i < potentialArrays.Count; i++)
            {
                var prevArray = potentialArrays[i - 1];
                var currentArray = potentialArrays[i];

                // Calculate the gap between arrays
                uint prevEnd = prevArray.StartAddress + (uint)(prevArray.Length * prevArray.Stride);
                uint gap = currentArray.StartAddress - prevEnd;

                // If arrays are close together and have similar properties, group them
                bool similarLengths = Math.Abs(currentArray.Length - prevArray.Length) <= Math.Max(1, (int)(prevArray.Length * 0.1)); // Within 10% length difference
                bool similarStrides = currentArray.Stride == prevArray.Stride;
                bool reasonableGap = gap <= Math.Max(0x100, prevArray.Stride * 4); // Allow larger gaps for larger strides

                // Also check if the end of previous array and start of current array align with their strides
                bool alignedWithStride = ((currentArray.StartAddress - prevArray.StartAddress) % prevArray.Stride) == 0;

                if (reasonableGap && similarLengths && similarStrides && alignedWithStride)
                {
                    currentGroup.Add(currentArray);
                }
                else
                {
                    if (currentGroup.Count > 0)
                    {
                        structureGroups.Add(new List<AdvancedComputation.StructureArray>(currentGroup));
                        currentGroup.Clear();
                    }
                    currentGroup.Add(currentArray);
                }
            }

            // Add the last group if it's not empty
            if (currentGroup.Count > 0)
            {
                structureGroups.Add(currentGroup);
            }

            // Process each group of arrays
            foreach (var group in structureGroups)
            {
                if (group.Count == 1)
                {
                    // Single array, add as is if it meets size criteria
                    bool meetsSizeCriteria = ctx.Config.VerboseLogging 
                        ? group[0].Length >= ctx.Config.MinArraySize 
                        : group[0].Length >= BookOfVariables.MinArrayElementsNonVerbose;
                    
                    if (meetsSizeCriteria)
                    {
                        arrays.Add(group[0]);
                        
                        // Mark nodes as assigned
                        foreach (var nodeIdx in group[0].NodeIndices)
                        {
                            nodeAssigned[nodeIdx] = true;
                        }
                    }
                }
                else
                {
                    // Multiple arrays, create a combined structure
                    var combinedArray = new AdvancedComputation.StructureArray
                    {
                        StartAddress = group[0].StartAddress,
                        EndAddress = group[^1].EndAddress,
                        Stride = group[0].Stride,
                        Length = (int)((group[^1].EndAddress - group[0].StartAddress) / group[0].Stride) + 1,
                        IsPartOfLargerStructure = true,
                        SubArrays = group
                    };

                    // Verify the combined array makes sense
                    bool isValidCombination = true;
                    for (int i = 1; i < group.Count; i++)
                    {
                        uint expectedStart = group[i - 1].StartAddress + (uint)(group[i - 1].Length * group[i - 1].Stride);
                        if (group[i].StartAddress < expectedStart || group[i].StartAddress > expectedStart + 0x100)
                        {
                            isValidCombination = false;
                            break;
                        }
                    }

                    if (!isValidCombination)
                    {
                        // If the combination isn't valid, add the arrays separately
                        foreach (var array in group)
                        {
                            // Apply minimum size filter based on verbose logging
                            bool meetsSizeCriteria = ctx.Config.VerboseLogging 
                                ? array.Length >= ctx.Config.MinArraySize 
                                : array.Length >= BookOfVariables.MinArrayElementsNonVerbose;
                                
                            if (meetsSizeCriteria)
                            {
                                arrays.Add(array);
                                foreach (var nodeIdx in array.NodeIndices)
                                {
                                    nodeAssigned[nodeIdx] = true;
                                }
                            }
                        }
                        continue;
                    }

                    // Combine all node indices
                    combinedArray.NodeIndices.AddRange(group.SelectMany(a => a.NodeIndices));

                    // Apply minimum size filter based on verbose logging for combined arrays
                    bool meetsCombinedSizeCriteria = ctx.Config.VerboseLogging 
                        ? combinedArray.Length >= ctx.Config.MinArraySize 
                        : combinedArray.Length >= BookOfVariables.MinArrayElementsNonVerbose;
                    
                    if (meetsCombinedSizeCriteria)
                    {
                        // Add to results
                        arrays.Add(combinedArray);

                        // Mark all nodes as assigned
                        foreach (var array in group)
                        {
                            foreach (var nodeIdx in array.NodeIndices)
                            {
                                nodeAssigned[nodeIdx] = true;
                            }
                        }

                        // Log the grouping
                        ctx.Log($"Grouped {group.Count} arrays into a larger structure at 0x{combinedArray.StartAddress:X8}-0x{combinedArray.EndAddress:X8}");
                    }
                }
            }

            return arrays;
        }

        private static AdvancedComputation.StructureArray? BuildStructureArray(
            AdvancedContext ctx,
            List<int> sortedNodeIndices,
            int startIndex,
            bool[] nodeAssigned)
        {
            if (startIndex >= sortedNodeIndices.Count)
                return null;

            var startNodeIdx = sortedNodeIndices[startIndex];
            var startAddr = ctx.RegularEntries[startNodeIdx].Address;

            // Limit the maximum array size to prevent excessive processing
            int maxArrayElements = ctx.Config.MaxArrayElements;

            // Try different strides (4, 8, 16, 32, 64 bytes are common)
            uint[] possibleStrides = { 4, 8, 16, 32, 64 };
            AdvancedComputation.StructureArray? bestArray = null;
            int bestLength = 0;

            foreach (uint stride in possibleStrides)
            {
                var array = new AdvancedComputation.StructureArray { Stride = stride };
                array.NodeIndices.Add(startNodeIdx);

                uint expectedNextAddr = startAddr + stride;
                int consecutive = 1;

                // Limit the lookahead to prevent excessive processing
                int maxLookahead = Math.Min(sortedNodeIndices.Count - startIndex, 500);

                // Look ahead to find consecutive elements with this stride
                for (int j = startIndex + 1; j < startIndex + maxLookahead; j++)
                {
                    if (j >= sortedNodeIndices.Count) break;

                    int currentIdx = sortedNodeIndices[j];
                    if (nodeAssigned[currentIdx])
                        continue;

                    uint currentAddr = ctx.RegularEntries[currentIdx].Address;

                    // If we've gone past where the next element should be, stop
                    if (currentAddr > expectedNextAddr + (stride * 2)) // Allow one missing element
                        break;

                    if (currentAddr == expectedNextAddr ||
                        (currentAddr > expectedNextAddr && currentAddr <= expectedNextAddr + stride))
                    {
                        array.NodeIndices.Add(currentIdx);
                        expectedNextAddr = currentAddr + stride;
                        consecutive++;

                        // Stop if we've hit our max size
                        if (consecutive >= maxArrayElements)
                            break;
                    }
                }

                // Track the best array we've found so far
                if (consecutive >= ctx.Config.MinArraySize && consecutive > bestLength)
                {
                    array.StartAddress = startAddr;
                    array.EndAddress = startAddr + (uint)((consecutive - 1) * stride);
                    array.Length = consecutive;

                    // Only analyze structure if this is the best candidate so far
                    if (consecutive > bestLength)
                    {
                        AnalyzeArrayStructure(ctx, array);
                        bestArray = array;
                        bestLength = consecutive;
                    }
                }
            }

            return bestArray;
        }

        private static void AnalyzeArrayStructure(AdvancedContext ctx, AdvancedComputation.StructureArray array)
        {
            if (array.Length == 0) return;

            // Sample up to 100 elements to determine common pointer offsets
            int sampleSize = Math.Min(100, array.Length);
            int step = Math.Max(1, array.Length / sampleSize);

            for (int i = 0; i < array.Length; i += step)
            {
                if (i >= array.NodeIndices.Count) break;

                int nodeIdx = array.NodeIndices[i];
                var entry = ctx.RegularEntries[nodeIdx];

                // Check each child slot for pointers (limit to first 16 slots for performance)
                int maxSlots = Math.Min(16, entry.ChildIndices.Length);
                for (int slot = 0; slot < maxSlots; slot++)
                {
                    if (entry.ChildIndices[slot] != -1)
                    {
                        uint offset = (uint)slot * 4;  // Assuming 4-byte slots
                        array.CommonPointerOffsets[offset] = array.CommonPointerOffsets.TryGetValue(offset, out int count)
                            ? count + 1
                            : 1;
                    }
                }
            }

            // Only keep offsets that appear in a significant number of elements
            int minOccurrences = Math.Max(2, sampleSize / 4); // At least 25% of sampled elements
            var toRemove = array.CommonPointerOffsets
                .Where(kv => kv.Value < minOccurrences)
                .Select(kv => kv.Key)
                .ToList();

            foreach (var offset in toRemove)
            {
                array.CommonPointerOffsets.Remove(offset);
            }

            // If we didn't find any common pointers, clear the array as it's likely not a real structure
            if (!array.CommonPointerOffsets.Any() && array.Length < 5)
            {
                array.Length = 0;
            }
        }
    }
}
