using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;

namespace PointerAnalysis
{
    // Orchestration for list detection. Delegates deterministic algorithms to ComputationHelpers.
    public class Computation
    {
        public class Config
        {
            public int MinListLength = BookOfVariables.MinListLength;
            public int MaxChainDepth = BookOfVariables.MaxChainDepth;
            public uint[] SlotOffsets = (uint[])BookOfVariables.PrimarySlotOffsets.Clone();
            public double DominantStrideRatio = BookOfVariables.DominantStrideRatio;
            public double BacklinkCoverageThreshold = BookOfVariables.BacklinkCoverageThreshold;
            public int MaxMissingPerGap = BookOfVariables.MaxMissingPerGap;
            public int MaxMissingPerList = BookOfVariables.MaxMissingPerList;
            public bool VerboseLogging = BookOfVariables.VerboseLogging;
            public bool CsvListsOutputEnabled = BookOfVariables.CsvListsOutputEnabled;

            public int EntryBackwardDepthLimit = BookOfVariables.EntrySourceBackwardDepthLimit;
            public int EntryChainDiscardThreshold = BookOfVariables.EntrySourceChainDiscardThreshold;
            public int EntryMaxShow = BookOfVariables.EntrySourceMaxReportedParents;
        }

        public class AnalysisNode
        {
            public int IndexInRegularList;
            public uint Address;
            public uint Value;
            public long Stride => (long)Value - (long)Address;
            public int[] ChildSlotIndices;
            public int[] ParentSlotIndices;
            public bool WasAssignedToStructure = false;

            public AnalysisNode(int slotCount)
            {
                ChildSlotIndices = Enumerable.Repeat(-1, slotCount).ToArray();
                ParentSlotIndices = Enumerable.Repeat(-1, slotCount).ToArray();
            }
        }

        /// <summary>
        /// Represents a detected data structure (like a linked list) with its properties and metadata.
        /// </summary>
        public class DetectedStructure
        {
            /// <summary>List of node indices in the structure (-1 indicates a placeholder for missing nodes)</summary>
            public List<int> OrderedGlobalNodeIndices = new List<int>();
            
            /// <summary>Indicates if the structure forms a complete loop/circle</summary>
            public bool IsCircular = false;
            
            /// <summary>Indicates if the structure has both forward and backward links</summary>
            public bool IsDoublyLinked = false;
            
            /// <summary>The memory offset used to detect this structure</summary>
            public uint OffsetUsedToDetect = 0;
            
            /// <summary>Common stride between elements if consistent</summary>
            public uint? CommonStride = null;
            
            /// <summary>Number of times the common stride was observed</summary>
            public int CommonStrideOccurrences = 0;
            
            /// <summary>Number of placeholder nodes inserted for missing elements</summary>
            public int MissingPlaceholderCount = 0;
            
            /// <summary>External entry points into this structure, keyed by offset</summary>
            public Dictionary<uint, List<EntryPoint>> ExternalEntryPointsByOffset = new Dictionary<uint, List<EntryPoint>>();
            
            /// <summary>Number of nodes trimmed from the beginning during analysis</summary>
            public int TrimmedHeadCount = 0;
            
            /// <summary>Address of the canonical root node (first node by default)</summary>
            public uint CanonicalRootAddress = 0;
            
            /// <summary>Gets the number of actual nodes (excluding placeholders)</summary>
            public int NodeCount => OrderedGlobalNodeIndices.Count(n => n >= 0);
            
            /// <summary>Gets the address of the first node if available</summary>
            public uint? FirstNodeAddress { get; internal set; }
            
            /// <summary>Gets the address of the last node if available</summary>
            public uint? LastNodeAddress { get; internal set; }
        }

        public class EntryPoint
        {
            public int SourceGlobalNodeIndex;
            public int TargetPositionZeroBased;
            public uint OffsetAtWhichSourcePoints;
            public bool SourceWasFromOtherStructure;
        }

        private readonly Config _config;
        private readonly StreamWriter _logWriter;
        private readonly string _outputPrefix;

        // runtime structures
        private List<Ingestion.MemoryEntry>? _regularEntries;
        private List<AnalysisNode>? _nodes;
        private Dictionary<uint, int>? _addressToIndex;

        public Computation(Config config, StreamWriter logWriter, string outputPrefix)
        {
            _config = config ?? throw new ArgumentNullException(nameof(config));
            _logWriter = logWriter ?? throw new ArgumentNullException(nameof(logWriter));
            _outputPrefix = outputPrefix;
        }

        private void Log(string s)
        {
            _logWriter.WriteLine(s);
            if (_config.VerboseLogging) Console.WriteLine(s);
            _logWriter.Flush();
        }
        
        /// <summary>
        /// Gets the address-to-index mapping used by this computation instance.
        /// </summary>
        /// <returns>A dictionary mapping memory addresses to their corresponding indices</returns>
        public Dictionary<uint, int> GetAddressToIndexMap()
        {
            return _addressToIndex ?? new Dictionary<uint, int>();
        }

        /// <summary>
        /// Analyzes memory entries to detect list-like data structures.
        /// </summary>
        /// <param name="regularEntries">List of memory entries to analyze</param>
        /// <param name="consumedSeeds">List of seed records that were consumed during ingestion</param>
        /// <returns>Tuple containing analysis nodes and detected structures</returns>
        public (List<AnalysisNode> AnalysisNodes, List<DetectedStructure> DetectedStructures) Analyze(
            List<Ingestion.MemoryEntry> regularEntries,
            List<Ingestion.SeedRecord> consumedSeeds)
        {
            _regularEntries = regularEntries;
            BuildAnalysisNodesFromRegularEntries(regularEntries);

            var ctx = new ComputationHelpers.ComputationContext
            {
                Config = _config,
                Nodes = _nodes!,
                RegularEntries = _regularEntries,
                LogWriter = _logWriter,
                AddressToIndex = _addressToIndex!
            };

            var detectedStructures = new List<DetectedStructure>();
            bool firstListWritten = false;
            int totalSlots = _config.SlotOffsets.Length;
            var nodeAssigned = new bool[_nodes!.Count];

            Log($"Computation: nodes={_nodes.Count}, slots={totalSlots}");

            // Phase A: seed-priority per-slot
            for (int slotIndex = 0; slotIndex < totalSlots; slotIndex++)
            {
                uint offset = _config.SlotOffsets[slotIndex];
                Log($"--- Seed-priority pass slot={slotIndex} offset=0x{offset:X} ---");

                var seedTargets = new List<int>();
                for (int i = 0; i < _nodes.Count; i++)
                {
                    if (nodeAssigned[i] || _nodes[i].WasAssignedToStructure) continue;
                    bool marked = _regularEntries![i].HasConsumedSelfSeed || _regularEntries[i].HasConsumedDoubleSeed;
                    if (!marked && _nodes[i].ParentSlotIndices[slotIndex] == -1) continue;
                    if (_nodes[i].ChildSlotIndices[slotIndex] == -1) continue;
                    seedTargets.Add(i);
                }

                seedTargets = seedTargets.Distinct().ToList();
                Log($"Seed-priority targets found: {seedTargets.Count}");

                foreach (var start in seedTargets)
                {
                    if (nodeAssigned[start] || _nodes[start].WasAssignedToStructure) continue;
                    var rawChain = ComputationHelpers.BuildChainFollowingSlot(ctx, start, slotIndex, nodeAssigned);
                    if (rawChain == null || rawChain.Count == 0) continue;
                    var ds = ComputationHelpers.AnalyzeRawChain(ctx, rawChain, slotIndex);
                    if (ds != null) PostProcessAndAcceptOrRecord(ctx, ds, detectedStructures, nodeAssigned, ref firstListWritten);
                }
            }

            // Phase B: global per-slot sweep
            for (int slotIndex = 0; slotIndex < totalSlots; slotIndex++)
            {
                uint offset = _config.SlotOffsets[slotIndex];
                Log($"--- Global pass slot={slotIndex} offset=0x{offset:X} ---");

                for (int i = 0; i < _nodes.Count; i++)
                {
                    if (nodeAssigned[i] || _nodes[i].WasAssignedToStructure) continue;
                    if (_nodes[i].ChildSlotIndices[slotIndex] == -1) continue;
                    var rawChain = ComputationHelpers.BuildChainFollowingSlot(ctx, i, slotIndex, nodeAssigned);
                    if (rawChain == null || rawChain.Count == 0) continue;
                    var ds = ComputationHelpers.AnalyzeRawChain(ctx, rawChain, slotIndex);
                    if (ds != null) PostProcessAndAcceptOrRecord(ctx, ds, detectedStructures, nodeAssigned, ref firstListWritten);
                }
            }

            // Merge/filter
            var merged = MergeFilter(detectedStructures);

            // Finalize each structure
            foreach (var ds in merged)
            {
                ComputationHelpers.RecomputeCommonStride(ctx, ds);
                ds.MissingPlaceholderCount = ComputationHelpers.BridgeGapsByStride(ctx, ds);
                ds.IsCircular = ComputationHelpers.DetectCircularity(ctx, ds);
                ds.IsDoublyLinked = ComputationHelpers.ComputeDoublyLinkedness(ctx, ds);
                ComputationHelpers.CollectGlobalEntryPointsWithChainFilter(ctx, ds, nodeAssigned);
                
                // Rotate the list to make the smallest address the canonical root
                RotateToCanonicalRoot(ds);
            }

            Log($"Computation complete: accepted structures {merged.Count}");
            return (_nodes!, merged);
        }

        /// <summary>
        /// Rotates the list so that the node with the smallest address becomes the canonical root.
        /// </summary>
        /// <param name="ds">The detected structure to rotate</param>
        private void RotateToCanonicalRoot(DetectedStructure ds)
        {
            if (ds.OrderedGlobalNodeIndices.Count == 0 || _nodes == null)
                return;

            // Find the node with the smallest address
            int minIndex = 0;
            uint minAddress = uint.MaxValue;
            
            for (int i = 0; i < ds.OrderedGlobalNodeIndices.Count; i++)
            {
                int nodeIndex = ds.OrderedGlobalNodeIndices[i];
                if (nodeIndex >= 0 && nodeIndex < _nodes.Count)
                {
                    uint address = _nodes[nodeIndex].Address;
                    if (address < minAddress)
                    {
                        minAddress = address;
                        minIndex = i;
                    }
                }
            }

            // If the first node already has the smallest address, no rotation needed
            if (minIndex == 0)
            {
                if (ds.OrderedGlobalNodeIndices[0] >= 0 && ds.OrderedGlobalNodeIndices[0] < _nodes.Count)
                {
                    ds.CanonicalRootAddress = _nodes[ds.OrderedGlobalNodeIndices[0]].Address;
                }
                return;
            }

            // Rotate the list to make the node with the smallest address the first node
            var rotatedList = new List<int>();
            
            // Add nodes from minIndex to the end
            for (int i = minIndex; i < ds.OrderedGlobalNodeIndices.Count; i++)
            {
                rotatedList.Add(ds.OrderedGlobalNodeIndices[i]);
            }
            
            // Add nodes from the beginning to minIndex-1
            for (int i = 0; i < minIndex; i++)
            {
                rotatedList.Add(ds.OrderedGlobalNodeIndices[i]);
            }

            // Update the ordered node indices
            ds.OrderedGlobalNodeIndices = rotatedList;
            
            // Update the canonical root address
            if (ds.OrderedGlobalNodeIndices[0] >= 0 && ds.OrderedGlobalNodeIndices[0] < _nodes.Count)
            {
                ds.CanonicalRootAddress = _nodes[ds.OrderedGlobalNodeIndices[0]].Address;
                Log($"Rotated list to make address 0x{ds.CanonicalRootAddress:X8} the canonical root (was previously at position {minIndex})");
            }
            
            // Check for and log any missing nodes
            int missingCount = 0;
            for (int i = 0; i < ds.OrderedGlobalNodeIndices.Count; i++)
            {
                if (ds.OrderedGlobalNodeIndices[i] < 0)
                {
                    missingCount++;
                    // Log the missing node and any entry points that reference it
                    if (i > 0 && ds.OrderedGlobalNodeIndices[i-1] >= 0 && ds.OrderedGlobalNodeIndices[i-1] < _nodes.Count)
                    {
                        uint prevAddress = _nodes[ds.OrderedGlobalNodeIndices[i-1]].Address;
                        Log($"MISSING Node{i} after address 0x{prevAddress:X8}");
                    }
                    else
                    {
                        Log($"MISSING Node{i} at the beginning of the list");
                    }
                }
            }
            
            if (missingCount > 0)
            {
                Log($"Note: {missingCount} missing nodes (placeholders) in the list");
            }
        }

        /// <summary>
        /// Converts memory entries into analysis nodes with parent/child relationships.
        /// </summary>
        /// <param name="entries">List of memory entries to convert</param>
        /// <exception cref="ArgumentNullException">Thrown if entries is null</exception>
        private void BuildAnalysisNodesFromRegularEntries(List<Ingestion.MemoryEntry> regularEntries)
        {
            int slotCount = _config.SlotOffsets.Length;
            _nodes = new List<AnalysisNode>(regularEntries.Count);
            _addressToIndex = new Dictionary<uint, int>(regularEntries.Count);
            
            for (int i = 0; i < regularEntries.Count; i++)
            {
                var re = regularEntries[i];
                var an = new AnalysisNode(slotCount)
                { 
                    IndexInRegularList = i, 
                    Address = re.Address, 
                    Value = re.Value
                };
                
                // Copy child and parent indices, ensuring we don't exceed bounds
                if (re.ChildIndices != null && re.ChildIndices.Length > 0)
                {
                    int copyLength = Math.Min(slotCount, re.ChildIndices.Length);
                    Array.Copy(re.ChildIndices, an.ChildSlotIndices, copyLength);
                }
                
                if (re.ParentIndices != null && re.ParentIndices.Length > 0)
                {
                    int copyLength = Math.Min(slotCount, re.ParentIndices.Length);
                    Array.Copy(re.ParentIndices, an.ParentSlotIndices, copyLength);
                }
                
                _nodes.Add(an);
                _addressToIndex[an.Address] = i;
            }
            Log($"Built {_nodes.Count} analysis nodes with {slotCount} slots each.");
        }

        /// <summary>
        /// Post-processes a candidate structure and adds it to the accepted list if it meets all criteria.
        /// </summary>
        /// <param name="ctx">Computation context with configuration and data</param>
        /// <param name="ds">The detected structure to evaluate</param>
        /// <param name="accepted">List of already accepted structures</param>
        /// <param name="nodeAssigned">Array tracking which nodes are already assigned to structures</param>
        /// <param name="firstListWritten">Reference to flag indicating if any list has been written yet</param>
        private void PostProcessAndAcceptOrRecord(ComputationHelpers.ComputationContext ctx, DetectedStructure ds, List<DetectedStructure> accepted, bool[] nodeAssigned, ref bool firstListWritten)
        {
            if (ds.CommonStride.HasValue)
            {
                var removed = ComputationHelpers.TrimLeadingNodesNotMatchingDominantStride(ctx, ds);
                ds.TrimmedHeadCount += removed.Count;
            }

            int preservedCount = ds.OrderedGlobalNodeIndices.Count(n => n >= 0);
            if (preservedCount < _config.MinListLength)
            {
                Log($"Reject: too short preserved={preservedCount}");
                return;
            }

            // compute backlink coverage using parent slots
            int backlinkHits = 0;
            var preservedSet = new HashSet<int>(ds.OrderedGlobalNodeIndices.Where(n => n >= 0));
            for (int p = 1; p < ds.OrderedGlobalNodeIndices.Count; p++)
            {
                int g = ds.OrderedGlobalNodeIndices[p];
                if (g < 0) continue;
                bool hit = false;
                for (int s = 0; s < _config.SlotOffsets.Length; s++)
                {
                    int parent = _nodes![g].ParentSlotIndices[s];
                    if (parent != -1 && preservedSet.Contains(parent)) { hit = true; break; }
                }
                if (hit) backlinkHits++;
            }

            double coverage = preservedCount > 1 ? (double)backlinkHits / Math.Max(1, preservedCount - 1) : 0.0;
            bool meetsCoverage = coverage >= _config.BacklinkCoverageThreshold;

            if (!meetsCoverage)
            {
                Log($"Reject by coverage: preserved={preservedCount} coverage={coverage:F2}");
                return;
            }

            ds.IsDoublyLinked = ComputationHelpers.ComputeDoublyLinkedness(ctx, ds);
            accepted.Add(ds);

            foreach (var g in ds.OrderedGlobalNodeIndices.Where(n => n >= 0))
            {
                nodeAssigned[g] = true;
                _nodes![g].WasAssignedToStructure = true;
            }

            Log($"Accepted structure offset=0x{ds.OffsetUsedToDetect:X} nodes={preservedCount} trimmedHeads={ds.TrimmedHeadCount} missingPlaceholders={ds.MissingPlaceholderCount} coverage={coverage:F2} doubly={ds.IsDoublyLinked}");
        }


        /// <summary>
        /// Removes structures that are subsets of others, keeping only the most complete structures.
        /// Uses efficient set operations for better performance with large lists.
        /// </summary>
        /// <param name="list">List of detected structures to filter</param>
        /// <returns>A filtered list containing only non-subset structures</returns>
        private List<DetectedStructure> MergeFilter(List<DetectedStructure> list)
        {
            if (list == null) throw new ArgumentNullException(nameof(list));
            if (list.Count <= 1) return new List<DetectedStructure>(list);

            var keep = new List<DetectedStructure>(list.Count);
            var nodeSets = new Dictionary<DetectedStructure, HashSet<int>>(list.Count);
            
            // Pre-compute node sets for faster comparison (only include valid node indices >= 0)
            foreach (var ds in list)
            {
                nodeSets[ds] = new HashSet<int>(ds.OrderedGlobalNodeIndices.Where(n => n >= 0));
            }

            for (int i = 0; i < list.Count; i++)
            {
                var current = list[i];
                var currentSet = nodeSets[current];
                bool isSubset = false;

                // Only compare with other structures that are at least as large
                for (int j = 0; j < list.Count && !isSubset; j++)
                {
                    if (i == j) continue;
                    
                    var other = list[j];
                    var otherSet = nodeSets[other];
                    
                    // Skip comparison if current set is larger than the other set
                    if (currentSet.Count > otherSet.Count) continue;
                    
                    // Check if current is a subset of other
                    isSubset = currentSet.IsSubsetOf(otherSet);
                }

                if (!isSubset)
                {
                    keep.Add(current);
                    
                    // If we're keeping this structure, mark its nodes as assigned
                    foreach (var nodeIdx in currentSet)
                    {
                        if (nodeIdx >= 0 && nodeIdx < _nodes!.Count)
                        {
                            _nodes[nodeIdx].WasAssignedToStructure = true;
                        }
                    }
                }
                else
                {
                    Log($"Filtered out a structure as it was a subset of another structure. Nodes: {currentSet.Count}");
                }
            }

            Log($"Filtered {list.Count} structures down to {keep.Count} non-subset structures");
            return keep;
        }
    }
}