using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading.Tasks;

namespace PointerAnalysis
{
    public static class Output
    {
        public static async Task SaveCsvData(string filePath, List<Computation.AnalysisNode> analysisNodes, List<Computation.DetectedStructure> detectedStructures)
        {
            if (!BookOfVariables.VerboseLogging)
            {
                return; // Skip CSV generation if verbose logging is disabled
            }

            var lines = new List<string>();
            
            // Add header
            lines.Add("Type,StartAddress,EndAddress,Length,Stride,IsCircular,IsDoublyLinked,NodeCount,EntryPoints");
            
            if (detectedStructures != null)
            {
                foreach (var structure in detectedStructures)
                {
                    if (structure.OrderedGlobalNodeIndices.Count == 0)
                        continue;
                        
                    // Get first and last valid nodes
                    var firstNodeIndex = structure.OrderedGlobalNodeIndices.FirstOrDefault(i => i >= 0);
                    var lastNodeIndex = structure.OrderedGlobalNodeIndices.LastOrDefault(i => i >= 0);
                    
                    if (firstNodeIndex < 0 || lastNodeIndex < 0)
                        continue;
                        
                    var firstNode = analysisNodes[firstNodeIndex];
                    var lastNode = analysisNodes[lastNodeIndex];
                    
                    // Count actual nodes (excluding placeholders)
                    int nodeCount = structure.OrderedGlobalNodeIndices.Count(i => i >= 0);
                    
                    // Count entry points
                    int entryPointCount = 0;
                    if (structure.ExternalEntryPointsByOffset.TryGetValue(structure.OffsetUsedToDetect, out var entryPoints))
                    {
                        entryPointCount = entryPoints.Count;
                    }
                    
                    lines.Add(string.Join(",", 
                        structure.IsCircular ? "Circular" : (structure.IsDoublyLinked ? "DoublyLinked" : "Linked"),
                        $"0x{firstNode.Address:X8}",
                        $"0x{lastNode.Address:X8}",
                        structure.OrderedGlobalNodeIndices.Count,
                        structure.CommonStride?.ToString() ?? "N/A",
                        structure.IsCircular ? "Yes" : "No",
                        structure.IsDoublyLinked ? "Yes" : "No",
                        nodeCount,
                        entryPointCount
                    ));
                }
            }
            
            await File.WriteAllLinesAsync(filePath, lines);
        }
        
        // Generate a human-readable report from analysis nodes and structures.
        // Entry points block lists only external parents (sources not in the list).
        public static string GenerateReport(List<Computation.AnalysisNode> analysisNodes, List<Computation.DetectedStructure> detectedStructures, string inputFilePath)
        {
            if (analysisNodes == null)
                throw new ArgumentNullException(nameof(analysisNodes));
                
            var sb = new StringBuilder();
            sb.AppendLine("=== POINTER ANALYSIS REPORT ===");
            sb.AppendLine($"Generated: {DateTime.Now}");
            sb.AppendLine($"Input file(s): {inputFilePath}");
            sb.AppendLine($"Total nodes: {analysisNodes.Count}");
            sb.AppendLine($"Detected structures: {(detectedStructures?.Count ?? 0)}");
            sb.AppendLine();

            sb.AppendLine("=== STRUCTURE SUMMARY ===");
            if (detectedStructures != null && detectedStructures.Any())
            {
                var structureGroups = detectedStructures
                    .GroupBy(ds => ds.IsCircular ? "Circular" : (ds.IsDoublyLinked ? "Doubly-Linked" : "Linked"))
                    .Select(g => new 
                    { 
                        Type = g.Key, 
                        NodeCount = g.Sum(ds => ds.OrderedGlobalNodeIndices.Count(n => n != -1)), 
                        Count = g.Count() 
                    });
                
                foreach (var g in structureGroups)
                {
                    sb.AppendLine($"{g.Type}: {g.NodeCount} nodes in {g.Count} structures");
                }
            }
            else
            {
                sb.AppendLine("No structures detected.");
            }
            sb.AppendLine();

            sb.AppendLine("=== DETECTED STRUCTURES ===");
            if (detectedStructures != null)
            {
                foreach (var ds in detectedStructures.OrderByDescending(d => d.OrderedGlobalNodeIndices.Count(n => n != -1)))
                {
                    if (ds.OrderedGlobalNodeIndices == null || ds.OrderedGlobalNodeIndices.All(i => i == -1)) continue;
                    string label = ds.IsCircular ? "Circular List" : (ds.IsDoublyLinked ? "Doubly-Linked List" : "Linked List");
                    sb.AppendLine($"{label} at canonical 0x{ds.CanonicalRootAddress:X8} (offset: 0x{ds.OffsetUsedToDetect:X})");
                    int visible = ds.OrderedGlobalNodeIndices.Count(i => i != -1);
                    int missing = ds.OrderedGlobalNodeIndices.Count(i => i == -1);
                    sb.AppendLine($"  Nodes: {visible}" + (missing > 0 ? $" (+{missing} missing)" : ""));
                    if (ds.CommonStride.HasValue) sb.AppendLine($"  Stride: 0x{ds.CommonStride.Value:X} (occurs {ds.CommonStrideOccurrences} times)");
                    sb.AppendLine($"  Trimmed heads: {ds.TrimmedHeadCount}");
                    int entries = ds.ExternalEntryPointsByOffset.Values.Sum(l => l.Count);
                    sb.AppendLine($"  Entry points discovered: {entries}");

                    // Detailed entry list block: show only external parents (source nodes not in the list)
                    if (ds.ExternalEntryPointsByOffset.TryGetValue(ds.OffsetUsedToDetect, out var eps) && eps.Count > 0)
                    {
                        sb.AppendLine("  Entry points:");
                        var grouped = eps.GroupBy(ep => ep.TargetPositionZeroBased).OrderBy(g => g.Key);
                        foreach (var g in grouped)
                        {
                            int nodePos = g.Key;
                            var distinctSources = g.Select(ep => ep.SourceGlobalNodeIndex).Distinct().ToList();
                            var shown = distinctSources.Take(BookOfVariables.EntrySourceMaxReportedParents).ToList();
                            var sourceAddrs = shown
                                .Where(si => si >= 0 && si < analysisNodes.Count)
                                .Select(si => $"0x{analysisNodes[si].Address:X8}")
                                .ToList();
                            string line = sourceAddrs.Any() 
                                ? $"    Node{nodePos} <- {string.Join(" <- ", sourceAddrs)}"
                                : $"    Node{nodePos} (no valid source addresses)";
                            if (distinctSources.Count > shown.Count)
                                line += $" (+{distinctSources.Count - shown.Count} more)";
                            sb.AppendLine(line);
                        }
                    }

                    sb.AppendLine();
                }
            }

            return sb.ToString();
        }

        /// <summary>
        /// Generate a detailed report of advanced structure detection results.
        /// </summary>
        public static string GenerateAdvancedReport(
            List<Computation.AnalysisNode> analysisNodes,
            List<AdvancedComputation.BinaryTree> trees,
            List<AdvancedComputation.PointerTable> tables,
            List<AdvancedComputation.StructureArray> arrays,
            string inputFilePath)
        {
            var sb = new StringBuilder();
            sb.AppendLine("=== ADVANCED STRUCTURE DETECTION REPORT ===");
            sb.AppendLine($"Generated: {DateTime.Now}");
            sb.AppendLine($"Input file(s): {inputFilePath}");
            sb.AppendLine($"Total nodes: {analysisNodes.Count}");
            sb.AppendLine($"Binary trees: {trees.Count}");
            sb.AppendLine($"Pointer tables: {tables.Count}");
            sb.AppendLine($"Structure arrays: {arrays.Count}");
            sb.AppendLine();

            // Binary Trees Section
            if (trees.Any())
            {
                sb.AppendLine("=== BINARY TREES ===");
                int treeNum = 1;
                foreach (var tree in trees.OrderByDescending(t => t.NodeIndices.Count))
                {
                    var rootNode = analysisNodes[tree.RootNodeIndex];
                    sb.AppendLine($"Tree #{treeNum++}:");
                    sb.AppendLine($"  Root: 0x{rootNode.Address:X8}");
                    sb.AppendLine($"  Nodes: {tree.NodeIndices.Count}");
                    sb.AppendLine($"  Max Depth: {tree.MaxDepth}");
                    sb.AppendLine($"  Balanced: {(tree.IsBalanced ? "Yes" : "No")}");
                    sb.AppendLine($"  Left Slot: 0x{tree.LeftSlotOffset * 4:X2}, Right Slot: 0x{tree.RightSlotOffset * 4:X2}");
                    sb.AppendLine();
                }
            }

            // Pointer Tables Section
            if (tables.Any())
            {
                sb.AppendLine("=== POINTER TABLES ===");
                int tableNum = 1;
                foreach (var table in tables.OrderByDescending(t => t.Length))
                {
                    sb.AppendLine($"Table #{tableNum++}:");
                    sb.AppendLine($"  Range: 0x{table.StartAddress:X8} - 0x{table.EndAddress:X8} ({table.Length} entries)");
                    sb.AppendLine($"  All same type: {(table.AllTargetsSameType ? "Yes" : "No")}");
                    
                    // Show first few target addresses
                    int showCount = Math.Min(5, table.TargetAddresses.Count);
                    sb.AppendLine($"  First {showCount} targets: {string.Join(", ", table.TargetAddresses.Take(showCount).Select(a => $"0x{a:X8}"))}");
                    
                    if (table.TargetAddresses.Count > showCount)
                        sb.AppendLine($"  + {table.TargetAddresses.Count - showCount} more targets...");
                    
                    sb.AppendLine();
                }
            }

            // Structure Arrays Section
            if (arrays.Any())
            {
                sb.AppendLine("=== STRUCTURE ARRAYS ===");
                int arrayNum = 1;
                var sortedArrays = arrays.OrderByDescending(a => a.SubArrays?.Count ?? 1).ThenByDescending(a => a.Length);
                
                foreach (var array in sortedArrays)
                {
                    if (array.IsPartOfLargerStructure && !array.SubArrays?.Any() == true)
                        continue; // Skip sub-arrays that are already included in a combined array
                        
                    sb.AppendLine($"Array #{arrayNum++}:");
                    
                    if (array.SubArrays?.Any() == true)
                    {
                        // This is a combined array
                        sb.AppendLine($"  Combined Array: {array.SubArrays.Count} sub-arrays");
                        sb.AppendLine($"  Total Range: 0x{array.StartAddress:X8} - 0x{array.EndAddress:X8} ({array.Length} total elements)");
                        sb.AppendLine($"  Stride: {array.Stride} bytes");
                        sb.AppendLine("  Sub-arrays:");
                        
                        foreach (var subArray in array.SubArrays)
                        {
                            sb.AppendLine($"    - 0x{subArray.StartAddress:X8} - 0x{subArray.EndAddress:X8} ({subArray.Length} elements)");
                        }
                    }
                    else
                    {
                        // Regular array
                        sb.AppendLine($"  Range: 0x{array.StartAddress:X8} - 0x{array.EndAddress:X8} ({array.Length} elements)");
                        sb.AppendLine($"  Stride: {array.Stride} bytes");
                    }
                    
                    if (array.CommonPointerOffsets.Any())
                    {
                        sb.AppendLine("  Common pointer offsets:");
                        foreach (var kvp in array.CommonPointerOffsets.OrderBy(kvp => kvp.Key))
                        {
                            sb.AppendLine($"    +0x{kvp.Key:X2}: {kvp.Value}/{array.Length} elements");
                        }
                    }
                    
                    sb.AppendLine();
                }
            }

            // Summary Section
            sb.AppendLine("=== SUMMARY ===");
            sb.AppendLine($"Total binary trees: {trees.Count} (avg. {(trees.Count > 0 ? trees.Average(t => t.NodeIndices.Count) : 0):F1} nodes/tree)");
            sb.AppendLine($"Total pointer tables: {tables.Count} (avg. {(tables.Count > 0 ? tables.Average(t => t.Length) : 0):F1} entries/table)");
            sb.AppendLine($"Total structure arrays: {arrays.Count} (avg. {(arrays.Count > 0 ? arrays.Average(a => a.Length) : 0):F1} elements/array)");

            return sb.ToString();
        }
    }
}