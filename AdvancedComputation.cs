using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace PointerAnalysis
{
    /// <summary>
    /// Advanced structure detection for trees, pointer tables, and structure arrays.
    /// Runs in parallel with standard linked list detection.
    /// </summary>
    public class AdvancedComputation
    {
        public class Config
        {
            public int MinTreeSize = 5;  // Minimum nodes for a valid tree
            public int MinTableSize = 5;  // Minimum pointers for a valid pointer table
            public int MinArraySize = 5;  // Minimum elements for a structure array
            public int MaxTreeDepth = 1000;  // Maximum depth when traversing trees
            public double StrideConsistencyRatio = 0.80;  // Ratio for array detection
            public bool VerboseLogging = false;

            // New safety caps
            public int MaxNodesToProcessForArrays = 50000;
            public int MaxArraysToDetect = 1000;
            public int MaxArrayElements = 1000;
            public int MaxTableRunScan = 10000;
            public int MaxBfsNodes = 10000;
        }

        public class BinaryTree
        {
            public int RootNodeIndex = -1;
            public List<int> NodeIndices = new List<int>();
            public int MaxDepth = 0;
            public int LeftSlotOffset = -1;
            public int RightSlotOffset = -1;
            public bool IsBalanced = false;
        }

        public class PointerTable
        {
            public uint StartAddress;
            public uint EndAddress;
            public int Length;
            public List<int> NodeIndices = new List<int>();
            public List<uint> TargetAddresses = new List<uint>();
            public bool AllTargetsSameType = false;  // Do all pointers point to similar structures?
        }

        public class StructureArray
        {
            public uint StartAddress;
            public uint EndAddress;
            public int Length;
            public uint Stride;
            public bool IsPartOfLargerStructure = false;  // Indicates if this array is part of a larger structure
            public List<int> NodeIndices = new List<int>();
            public Dictionary<uint, int> CommonPointerOffsets = new Dictionary<uint, int>();  // offset -> occurrence count
            public List<StructureArray>? SubArrays { get; set; }  // For arrays that are part of a larger structure
        }

        private readonly Config _config;
        private readonly StreamWriter _logWriter;
        private readonly string _outputPrefix;

        private List<Ingestion.MemoryEntry>? _regularEntries;
        private List<Computation.AnalysisNode>? _nodes;
        private Dictionary<uint, int>? _addressToIndex;

        public AdvancedComputation(Config config, StreamWriter logWriter, string outputPrefix)
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
        /// Analyze memory entries for advanced structures (trees, tables, arrays).
        /// Order: Trees -> Tables -> Arrays (arrays detected once globally after trees/tables).
        /// </summary>
        public (List<BinaryTree> Trees, List<PointerTable> Tables, List<StructureArray> Arrays) Analyze(
            List<Ingestion.MemoryEntry> regularEntries,
            List<Computation.AnalysisNode> analysisNodes,
            Dictionary<uint, int> addressToIndex,
            bool[] nodeAssigned)
        {
            _regularEntries = regularEntries;
            _nodes = analysisNodes;
            _addressToIndex = addressToIndex;

            var ctx = new AdvancedComputationHelpers.AdvancedContext
            {
                Config = _config,
                Nodes = _nodes,
                RegularEntries = _regularEntries,
                LogWriter = _logWriter,
                AddressToIndex = _addressToIndex
            };

            var trees = new List<BinaryTree>();
            var tables = new List<PointerTable>();
            var arrays = new List<StructureArray>();

            Log($"AdvancedComputation: Starting analysis on {_nodes.Count} nodes");

            // Phase 1: Detect Binary Trees
            Log("--- Phase 1: Binary Tree Detection ---");
            trees = AdvancedComputationHelpers.DetectBinaryTrees(ctx, nodeAssigned);
            Log($"Detected {trees.Count} binary trees");

            // Phase 2: Detect Pointer Tables
            Log("--- Phase 2: Pointer Table Detection ---");
            tables = AdvancedComputationHelpers.DetectPointerTables(ctx, nodeAssigned);
            Log($"Detected {tables.Count} pointer tables");

            // Phase 3: Detect Structure Arrays (detect once globally, after trees & tables)
            Log("--- Phase 3: Structure Array Detection (global) ---");
            arrays = AdvancedComputationHelpers.DetectStructureArrays(ctx, nodeAssigned);
            // Ensure arrays are sorted by start address for downstream consumers
            arrays = arrays.OrderBy(a => a.StartAddress).ToList();
            Log($"Detected {arrays.Count} structure arrays (sorted)");

            Log($"AdvancedComputation complete: trees={trees.Count}, tables={tables.Count}, arrays={arrays.Count}");
            return (trees, tables, arrays);
        }
    }
}
