using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading.Tasks;

namespace PointerAnalysis
{
    public static class BookOfVariables
    {
        // ===== General Configuration =====
        
        // List detection thresholds
        public static int MinListLength = 10;  
        public static int MaxChainDepth = 10000;
        public static int HotReferenceThreshold = 50;
        
        // Memory scanning configuration
        public static uint SelfDoubleScanCap = 0x20;
        public static uint MaxOffsetToConsider = 0x20;
        
        // Slot offset patterns - dynamically generated based on MaxOffsetToConsider
        public static uint[] PrimarySlotOffsets => GenerateSlotOffsets(MaxOffsetToConsider, 4);
        public static uint[] AlternateSlotOffsets => GenerateSlotOffsets(MaxOffsetToConsider, 2);

        // Helper to generate slot offsets dynamically
        private static uint[] GenerateSlotOffsets(uint maxOffset, uint step)
        {
            var offsets = new List<uint>();
            for (uint offset = 0; offset <= maxOffset; offset += step)
            {
                offsets.Add(offset);
            }
            return offsets.ToArray();
        }

        // Memory alignment requirements
        public static int PrimarySlotAlignmentModulo = 4;
        public static int AlternateSlotAlignmentModulo = 2;

        // ===== List Validation Rules =====
        
        // Stride analysis
        public static double DominantStrideRatio = 0.75;
        
        // Backlink validation
        public static double BacklinkCoverageThreshold = 0.50;
        public static double BacklinkCoverageAcceptanceThreshold => BacklinkCoverageThreshold;  // Alias for backward compatibility
        
        // Gap filling
        public static int MaxMissingPerGap = 2;
        public static int MaxMissingPerList = 6;

        // ===== Entry Point Configuration =====
        
        // Entry point discovery
        public static int EntryBackwardDepthLimit = 6;  // Walk up to 6 parents (so >5 discarded)
        public static int EntrySourceBackwardDepthLimit => EntryBackwardDepthLimit;  // Alias for backward compatibility
        public static int EntrySourceMaxReportedParents = 12;  // Show up to 12 sources in report
        public static int EntryChainDiscardThreshold = 5;  // If parent chain length >5 discard
        public static int EntrySourceChainDiscardThreshold => EntryChainDiscardThreshold;  // Alias for backward compatibility
        
        // Maximum list length to show entry points for (0 = no limit)
        // When VerboseLogging is false, entry points are only shown for lists with 500 or fewer nodes
        public static int MaxListLengthForEntryPoints => VerboseLogging ? 0 : 500;

        // ===== Output Control =====
        
        // Logging and output
        public static bool VerboseLogging = false;
        public static bool CsvListsOutputEnabled = false;
        
        // Advanced structure detection
        public static bool FilterStructuresWithAdvancedDetection = true;
        
        // Non-verbose mode thresholds
        public static int MinArrayElementsNonVerbose = 10;    // Minimum array elements when not in verbose mode
        public static int MinTableElementsNonVerbose = 10;    // Minimum hash table elements when not in verbose mode
        public static int MinTreeDepthNonVerbose = 5;        // Minimum tree depth when not in verbose mode
        public static readonly string TxtLogFileName = "pointer_analysis_log.txt";
        public static readonly string ConsumedSeedsCsvSuffix = "_consumed_seeds.csv";
        public static readonly string RegularTuplesCsvSuffix = "_regular_tuples.csv";
        public static readonly string FirstIngestedListCsvSuffix = "_first_ingested_list.csv";
        public static readonly string ListsCsvSuffix = "_lists";
        public static readonly string ReportSuffix = "_report.txt";
        public static readonly string SummaryCsvSuffix = "_summary.csv";

        // File-group regex for Name_System_index
        public static readonly Regex MergeGroupRegex = new Regex(@"^(?<name>.+)_(?<system>[A-Za-z0-9]+)_[0-9]+\.csv$", RegexOptions.Compiled | RegexOptions.IgnoreCase);

        // Platform descriptor used by ingestion. Public so Ingestion can read it.
        public class PlatformDescriptor
        {
            public string Key = "default";
            public uint? PointerMask = null;         // mask to apply to values (null = no mask)
            public List<(uint Start, uint End)> ValidRanges = new List<(uint, uint)>();
        }

        // Central platform dictionary (populate here)
        public static readonly Dictionary<string, PlatformDescriptor> Platforms = new Dictionary<string, PlatformDescriptor>(StringComparer.OrdinalIgnoreCase)
        {
            // GBA: 0x02000000 - 0x0203FFFF, 24-bit mask
            ["gba"] = new PlatformDescriptor
            {
                Key = "gba",
                PointerMask = 0x00FFFFFFu,
                ValidRanges = new List<(uint,uint)>{ (0x02000000u, 0x0203FFFFu) }
            },

            // PS1: 0x80000000 - 0x801FFFFF, clear top bit mask => 0x7FFFFFFF
            ["ps1"] = new PlatformDescriptor
            {
                Key = "ps1",
                PointerMask = 0x7FFFFFFFu,
                ValidRanges = new List<(uint,uint)>{ (0x80000000u, 0x801FFFFFu) }
            },

            // Nintendo DS (ARM9): 0x02000000 - 0x02FFFFFF, 24-bit mask
            ["nds"] = new PlatformDescriptor
            {
                Key = "nds",
                PointerMask = 0x00FFFFFFu,
                ValidRanges = new List<(uint,uint)>{ (0x02000000u, 0x02FFFFFFu) }
            },

            // PSP: 0x08000000 - 0x0BFFFFFF, clear top 4 bits mask => 0x07FFFFFF
            ["psp"] = new PlatformDescriptor
            {
                Key = "psp",
                PointerMask = 0x07FFFFFFu,
                ValidRanges = new List<(uint,uint)>{ (0x08000000u, 0x0BFFFFFFu) }
            },

            // Sega DC: 0x8C000000 - 0x8CFFFFFF, 24-bit mask
            ["DC"] = new PlatformDescriptor
            {
                Key = "DC",
                PointerMask = 0x00FFFFFFu,
                ValidRanges = new List<(uint,uint)>{ (0x8C000000u, 0x8CFFFFFFu) }
            },

            // PlayStation 2: 0x00100000 - 0x01FFFFFF, no mask
            ["ps2"] = new PlatformDescriptor
            {
                Key = "ps2",
                PointerMask = null,
                ValidRanges = new List<(uint,uint)>{ (0x00100000u, 0x01FFFFFFu) }
            },

            // GameCube: 0x80000000 - 0x817FFFFF, clear top bit mask => 0x7FFFFFFF
            ["gc"] = new PlatformDescriptor
            {
                Key = "gc",
                PointerMask = 0x7FFFFFFFu,
                ValidRanges = new List<(uint,uint)>{ (0x80000000u, 0x817FFFFFu) }
            },

            // Wii: two ranges; clear top bit mask => 0x7FFFFFFF
            ["wii"] = new PlatformDescriptor
            {
                Key = "wii",
                PointerMask = 0x7FFFFFFFu,
                ValidRanges = new List<(uint,uint)>{ (0x80000000u, 0x817FFFFFu), (0x90000000u, 0x93FFFFFFu) }
            },

            // Default (fallback) entry
            ["default"] = new PlatformDescriptor
            {
                Key = "default",
                PointerMask = null,
                ValidRanges = new List<(uint,uint)>() // empty = accept anything
            }
        };

        // Helper: find platform descriptor by filename hint or fallback key
        public static PlatformDescriptor GetPlatformByHint(string? hint)
        {
            if (string.IsNullOrWhiteSpace(hint)) return Platforms["default"];
            var h = hint.ToLowerInvariant();
            foreach (var k in Platforms.Keys)
            {
                if (h.Contains(k)) return Platforms[k];
            }
            if (Platforms.TryGetValue(hint, out var pd)) return pd;
            return Platforms["default"];
        }
    }

    internal static class Program
    {
        public static async Task<int> Main(string[] args)
        {
            try
            {
                if (args.Length >= 1 && File.Exists(args[0]))
                {
                    // Non-interactive mode with file path as argument
                    string outputDir = args.Length > 1 ? args[1] : Path.GetDirectoryName(args[0]) ?? ".";
                    await ProcessFile(args[0], outputDir);
                    return 0;
                }
                else if (args.Length >= 1 && Directory.Exists(args[0]))
                {
                    // Non-interactive mode with directory as argument
                    string outputDir = args.Length > 1 ? args[1] : args[0];
                    await ProcessDirectory(args[0], outputDir);
                    return 0;
                }
                else if (args.Length > 0 && (args[0] == "-i" || args[0] == "--interactive" || args[0] == "/i"))
                {
                    // Explicit interactive mode
                    await InteractiveRunner.RunInteractive();
                    return 0;
                }
                else
                {
                    // Default to interactive mode if no valid arguments provided
                    await InteractiveRunner.RunInteractive();
                    return 0;
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"An error occurred: {ex.Message}");
                Console.WriteLine("\nUsage:");
                Console.WriteLine("  Interactive mode: PointerAnalysis");
                Console.WriteLine("  Process file:     PointerAnalysis <input_file> [output_dir]");
                Console.WriteLine("  Process directory: PointerAnalysis <input_dir> [output_dir]");
                Console.WriteLine("  Force interactive: PointerAnalysis -i");
                return 1;
            }
        }

        private static string DetectPlatformFromFilename(string file)
        {
            var name = Path.GetFileName(file) ?? "";
            var lowerName = name.ToLowerInvariant();

            // Check for each platform in the BookOfVariables
            if (lowerName.Contains("gba")) return "gba";
            if (lowerName.Contains("ps1")) return "ps1";
            if (lowerName.Contains("nds")) return "nds";
            if (lowerName.Contains("psp")) return "psp";
            if (lowerName.Contains("DC")) return "DC";
            if (lowerName.Contains("ps2")) return "ps2";
            if (lowerName.Contains("gc") || lowerName.Contains("gamecube")) return "gc";
            if (lowerName.Contains("wii")) return "wii";

            return "default";
        }

        private static async Task SaveConsumedSeedsCsv(string path, List<Ingestion.SeedRecord> consumedSeeds)
        {
            var lines = new List<string> { "OriginalLineIndex,Address,Value,IsSelfSeed,IsDoubleSeed,SourceAddresses" };
            foreach (var s in consumedSeeds)
            {
                string sources = s.SourceAddresses != null && s.SourceAddresses.Count > 0 ? string.Join(";", s.SourceAddresses.ConvertAll(a => $"0x{a:X8}")) : "";
                lines.Add(string.Join(",", s.OriginalLineIndex, $"0x{s.Address:X8}", $"0x{s.Value:X8}", s.IsSelfBacklinkSeed ? 1 : 0, s.IsDoubleBacklinkSeed ? 1 : 0, sources));
            }
            await File.WriteAllLinesAsync(path, lines);
        }

        private static async Task SaveRegularTuplesCsv(string path, List<Ingestion.MemoryEntry> regularTuples)
        {
            var lines = new List<string> { "Address,Value,Stride,ForwardRefs,BackwardRefs,HasConsumedSelfSeed,HasConsumedDoubleSeed" };
            foreach (var e in regularTuples)
            {
                lines.Add(string.Join(",", $"0x{e.Address:X8}", $"0x{e.Value:X8}", e.Stride, e.ReferenceCount.Forward, e.ReferenceCount.Backward, e.HasConsumedSelfSeed ? 1 : 0, e.HasConsumedDoubleSeed ? 1 : 0));
            }
            await File.WriteAllLinesAsync(path, lines);
        }

        internal static async Task ProcessFile(string filePath, string outputDir)
        {
            Console.WriteLine($"Processing file: {filePath}");
            
            // Create output directory if it doesn't exist
            Directory.CreateDirectory(outputDir);
            
            // Process the file using the existing logic
            var platformHint = DetectPlatformFromFilename(filePath);
            var filesToProcess = new List<(string GroupKey, List<string> Files, string PlatformHint)>();
            filesToProcess.Add((Path.GetFileNameWithoutExtension(filePath), new List<string> { filePath }, platformHint));
            
            await ProcessFileGroup(filesToProcess[0], outputDir);
        }

        internal static async Task ProcessDirectory(string directoryPath, string outputDir)
        {
            Console.WriteLine($"Processing directory: {directoryPath}");
            
            // Create output directory if it doesn't exist
            Directory.CreateDirectory(outputDir);
            
            // Group files by common prefix (everything before the last underscore) and platform
            var files = Directory.GetFiles(directoryPath, "*.csv");
            var filesByGroup = files
                .Select(f => new { 
                    File = f, 
                    Name = Path.GetFileNameWithoutExtension(f),
                    // Get the common prefix (everything before the last underscore)
                    GroupKey = Path.GetFileNameWithoutExtension(f).Contains('_') 
                        ? string.Join("_", Path.GetFileNameWithoutExtension(f).Split('_')[..^1])
                        : Path.GetFileNameWithoutExtension(f),
                    Platform = DetectPlatformFromFilename(f)
                })
                .GroupBy(x => (x.GroupKey, x.Platform))
                .Select(g => (GroupKey: g.Key.GroupKey, Files: g.Select(x => x.File).ToList(), PlatformHint: g.Key.Platform))
                .ToList();
            
            foreach (var group in filesByGroup)
            {
                var groupKey = group.GroupKey;
                var platform = group.PlatformHint;
                var fileList = group.Files.OrderBy(f => f).ToList();
                
                await ProcessFileGroup((groupKey, fileList, platform), outputDir);
            }
        }
        
        private static async Task ProcessFileGroup((string GroupKey, List<string> Files, string PlatformHint) group, string outputDir)
        {
            var groupPrefix = Path.Combine(outputDir, group.GroupKey);
            
            // Create a dummy StreamWriter that discards output when verbose logging is disabled
            var logWriter = BookOfVariables.VerboseLogging 
                ? new StreamWriter($"{groupPrefix}_{BookOfVariables.TxtLogFileName}", append: false)
                : new StreamWriter(Stream.Null) { AutoFlush = true };
            
            try
            {
                // Log function that writes to both console and log writer
                void Log(string s) 
                { 
                    Console.WriteLine(s);
                    logWriter.WriteLine(s);
                    logWriter.Flush();
                }
                
                Log($"=== Processing group: {group.GroupKey} ===");
                Log($"Files: {string.Join(", ", group.Files.Select(Path.GetFileName))}");
                Log($"Platform hint: {group.PlatformHint}");

                var ingConfig = new Ingestion.Config
                {
                    MinListLength = BookOfVariables.MinListLength,
                    MaxChainLength = BookOfVariables.MaxChainDepth,
                    HotReferenceThreshold = BookOfVariables.HotReferenceThreshold,
                    SelfDoubleScanCap = BookOfVariables.SelfDoubleScanCap,
                    SlotOffsets = BookOfVariables.PrimarySlotOffsets,
                    SlotAlignmentModulo = BookOfVariables.PrimarySlotAlignmentModulo,
                    VerboseLogging = BookOfVariables.VerboseLogging
                };

                var ingestion = new Ingestion(ingConfig);
                List<Ingestion.MemoryEntry> regularTuples;
                List<Ingestion.SeedRecord> consumedSeeds;
                int totalFwd, totalBwd;
                
                if (group.Files.Count == 1)
                {
                    (regularTuples, consumedSeeds, totalFwd, totalBwd) = ingestion.LoadEntries(group.Files[0], group.PlatformHint);
                }
                else
                {
                    (regularTuples, consumedSeeds, totalFwd, totalBwd) = ingestion.LoadEntries(group.Files, group.PlatformHint);
                }

                if (BookOfVariables.VerboseLogging)
                {
                    Log($"Ingestion complete: regular tuples={regularTuples.Count}, consumedSeeds={consumedSeeds.Count}");
                    Log($"Reference totals: forward={totalFwd}, backward={totalBwd}");

                    string consumedCsv = $"{groupPrefix}{BookOfVariables.ConsumedSeedsCsvSuffix}";
                    await SaveConsumedSeedsCsv(consumedCsv, consumedSeeds);
                    Log($"Wrote consumed seeds CSV: {consumedCsv}");

                    string regularCsv = $"{groupPrefix}{BookOfVariables.RegularTuplesCsvSuffix}";
                    await SaveRegularTuplesCsv(regularCsv, regularTuples);
                    Log($"Wrote regular tuples CSV: {regularCsv}");
                }

                var compConfig = new Computation.Config
                {
                    MinListLength = BookOfVariables.MinListLength,
                    MaxChainDepth = BookOfVariables.MaxChainDepth,
                    SlotOffsets = BookOfVariables.PrimarySlotOffsets,
                    DominantStrideRatio = BookOfVariables.DominantStrideRatio,
                    BacklinkCoverageThreshold = BookOfVariables.BacklinkCoverageThreshold,
                    MaxMissingPerGap = BookOfVariables.MaxMissingPerGap,
                    MaxMissingPerList = BookOfVariables.MaxMissingPerList,
                    VerboseLogging = BookOfVariables.VerboseLogging,
                    CsvListsOutputEnabled = BookOfVariables.CsvListsOutputEnabled,
                    EntryBackwardDepthLimit = BookOfVariables.EntrySourceBackwardDepthLimit,
                    EntryChainDiscardThreshold = BookOfVariables.EntrySourceChainDiscardThreshold,
                    EntryMaxShow = BookOfVariables.EntrySourceMaxReportedParents
                };

                var computation = new Computation(compConfig, logWriter, groupPrefix);
                Log("Starting computation...");
                var (analysisNodes, detectedStructures) = computation.Analyze(regularTuples, consumedSeeds);

                // Always generate and save the report file
                string reportPath = $"{groupPrefix}{BookOfVariables.ReportSuffix}";
                var report = Output.GenerateReport(analysisNodes, detectedStructures, string.Join(";", group.Files));
                await File.WriteAllTextAsync(reportPath, report);
                
                Log($"Computation complete: detected {detectedStructures.Count} structures.");
                Log($"Wrote report: {reportPath}");

                if (BookOfVariables.VerboseLogging)
                {
                    string summaryCsv = $"{groupPrefix}{BookOfVariables.SummaryCsvSuffix}";
                    await Output.SaveCsvData(summaryCsv, analysisNodes, detectedStructures);
                    Log($"Wrote summary CSV: {summaryCsv}");
                }
                
                // Always run advanced computation, but only log verbosely if enabled
                try
                {
                    Log("\n=== Starting Advanced Structure Detection ===");
                    var advancedConfig = new AdvancedComputation.Config
                    {
                        MinTreeSize = 5,
                        MinTableSize = 5,
                        MinArraySize = 5,
                        MaxTreeDepth = 1000,
                        StrideConsistencyRatio = 0.80,
                        VerboseLogging = BookOfVariables.VerboseLogging
                    };
                    
                    var advancedComputation = new AdvancedComputation(advancedConfig, logWriter, groupPrefix);
                    
                    // Mark nodes already assigned to structures
                    var nodeAssigned = new bool[analysisNodes.Count];
                    foreach (var ds in detectedStructures)
                    {
                        foreach (var nodeIdx in ds.OrderedGlobalNodeIndices.Where(i => i >= 0))
                        {
                            if (nodeIdx < nodeAssigned.Length)
                                nodeAssigned[nodeIdx] = true;
                        }
                    }
                    
                    // Create address-to-index map for advanced computation
                    var addressToIndex = new Dictionary<uint, int>();
                    for (int i = 0; i < analysisNodes.Count; i++)
                    {
                        addressToIndex[analysisNodes[i].Address] = i;
                    }
                    
                    // Run advanced analysis
                    var (trees, tables, arrays) = advancedComputation.Analyze(
                        regularTuples,
                        analysisNodes,
                        addressToIndex,
                        nodeAssigned);
                        
                    // Generate and save advanced report
                    string advancedReportPath = $"{groupPrefix}_advanced_report.txt";
                    var advancedReport = Output.GenerateAdvancedReport(
                        analysisNodes, 
                        trees, 
                        tables, 
                        arrays, 
                        string.Join(";", group.Files));
                        
                    await File.WriteAllTextAsync(advancedReportPath, advancedReport);
                    Log($"Advanced structure detection complete. Wrote report: {advancedReportPath}");
                    
                    // If filtering is enabled, remove structures that are already covered by advanced detection
                    if (BookOfVariables.FilterStructuresWithAdvancedDetection)
                    {
                        // Create a set of all node indices that are part of advanced structures
                        var advancedNodeIndices = new HashSet<int>();
                        
                        // Add nodes from trees
                        foreach (var tree in trees)
                        {
                            foreach (var nodeIdx in tree.NodeIndices)
                            {
                                advancedNodeIndices.Add(nodeIdx);
                            }
                        }
                        
                        // Add nodes from pointer tables
                        foreach (var table in tables)
                        {
                            foreach (var nodeIdx in table.NodeIndices)
                            {
                                if (nodeIdx >= 0) advancedNodeIndices.Add(nodeIdx);
                            }
                        }
                        
                        // Add nodes from structure arrays
                        foreach (var array in arrays)
                        {
                            foreach (var nodeIdx in array.NodeIndices)
                            {
                                if (nodeIdx >= 0) advancedNodeIndices.Add(nodeIdx);
                            }
                        }
                        
                        // Filter out structures that are mostly covered by advanced detection
                        int originalCount = detectedStructures.Count;
                        detectedStructures = detectedStructures
                            .Where(ds => 
                            {
                                // Count how many nodes in this structure are already in advanced structures
                                int overlap = ds.OrderedGlobalNodeIndices
                                    .Count(i => i >= 0 && advancedNodeIndices.Contains(i));
                                
                                // Keep the structure if less than 50% of its nodes are in advanced structures
                                // or if it's a small structure (less than 5 nodes)
                                return overlap == 0 || 
                                       (float)overlap / ds.OrderedGlobalNodeIndices.Count(i => i >= 0) < 0.5f ||
                                       ds.OrderedGlobalNodeIndices.Count(i => i >= 0) < 5;
                            })
                            .ToList();
                        
                        int removed = originalCount - detectedStructures.Count;
                        if (removed > 0)
                        {
                            Log($"Filtered out {removed} structures that are better explained by advanced detection");
                            
                            // Regenerate the main report with filtered structures
                            report = Output.GenerateReport(analysisNodes, detectedStructures, string.Join(";", group.Files));
                            await File.WriteAllTextAsync(reportPath, report);
                            Log($"Updated main report with {detectedStructures.Count} filtered structures");
                        }
                    }
                }
                catch (Exception ex)
                {
                    Log($"Error during advanced structure detection: {ex.Message}");
                    if (BookOfVariables.VerboseLogging)
                    {
                        Log($"Stack trace: {ex.StackTrace}");
                    }
                }

                Log($"Finished processing group: {group.GroupKey}");
            }
            finally
            {
                await logWriter.DisposeAsync();
            }
        }
    }
}