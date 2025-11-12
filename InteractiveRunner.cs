using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;

 namespace PointerAnalysis
 {
     public static class InteractiveRunner
     {
         public static async Task RunInteractive()
         {
             Console.WriteLine("=== The BigDonRAM Pointer Analysis Tool ===");
             Console.WriteLine("Interactive Configuration Mode");
             Console.WriteLine();
 
             // Ask if user wants to use default settings
             Console.Write("Use default settings? (Y/n): ");
             var useDefaults = !string.Equals(Console.ReadLine(), "n", StringComparison.OrdinalIgnoreCase);
             
             if (!useDefaults)
             {
                 Console.WriteLine("\n=== Configuring Analysis Parameters ===");
                 
                 // List detection thresholds
                 BookOfVariables.MinListLength = ReadInt("Minimum list length", BookOfVariables.MinListLength);
                 BookOfVariables.MaxChainDepth = ReadInt("Maximum chain depth", BookOfVariables.MaxChainDepth);
                 BookOfVariables.HotReferenceThreshold = ReadInt("Hot reference threshold", BookOfVariables.HotReferenceThreshold);
                 
                 // Memory scanning configuration
                 BookOfVariables.SelfDoubleScanCap = ReadHexUInt("Self/double scan cap", BookOfVariables.SelfDoubleScanCap);
                 BookOfVariables.MaxOffsetToConsider = ReadHexUInt("Maximum offset to consider", BookOfVariables.MaxOffsetToConsider);
                 
                 // Memory alignment
                 BookOfVariables.PrimarySlotAlignmentModulo = ReadInt("Primary slot alignment modulo", BookOfVariables.PrimarySlotAlignmentModulo);
                 BookOfVariables.AlternateSlotAlignmentModulo = ReadInt("Alternate slot alignment modulo", BookOfVariables.AlternateSlotAlignmentModulo);
                 
                 // List validation rules
                 BookOfVariables.DominantStrideRatio = ReadDouble("Dominant stride ratio", BookOfVariables.DominantStrideRatio);
                 BookOfVariables.BacklinkCoverageThreshold = ReadDouble("Backlink coverage threshold", BookOfVariables.BacklinkCoverageThreshold);
                 BookOfVariables.MaxMissingPerGap = ReadInt("Maximum missing per gap", BookOfVariables.MaxMissingPerGap);
                 BookOfVariables.MaxMissingPerList = ReadInt("Maximum missing per list", BookOfVariables.MaxMissingPerList);
                 
                 // Entry point configuration
                 BookOfVariables.EntryBackwardDepthLimit = ReadInt("Entry backward depth limit", BookOfVariables.EntryBackwardDepthLimit);
                 BookOfVariables.EntrySourceMaxReportedParents = ReadInt("Maximum reported parent entries", BookOfVariables.EntrySourceMaxReportedParents);
                 BookOfVariables.EntryChainDiscardThreshold = ReadInt("Entry chain discard threshold", BookOfVariables.EntryChainDiscardThreshold);
                 
                 // Output control
                BookOfVariables.VerboseLogging = ReadYesNo("Enable verbose logging", BookOfVariables.VerboseLogging);
                
                // Only show non-verbose thresholds if verbose logging is off
                if (!BookOfVariables.VerboseLogging)
                {
                    Console.WriteLine("\n=== Non-Verbose Mode Thresholds ===");
                    BookOfVariables.MinArrayElementsNonVerbose = ReadInt("  Minimum array elements to show", BookOfVariables.MinArrayElementsNonVerbose);
                    BookOfVariables.MinTableElementsNonVerbose = ReadInt("  Minimum hash table elements to show", BookOfVariables.MinTableElementsNonVerbose);
                    BookOfVariables.MinTreeDepthNonVerbose = ReadInt("  Minimum tree depth to show", BookOfVariables.MinTreeDepthNonVerbose);
                }
                
                BookOfVariables.FilterStructuresWithAdvancedDetection = ReadYesNo("Filter structures using advanced detection", BookOfVariables.FilterStructuresWithAdvancedDetection);
                BookOfVariables.CsvListsOutputEnabled = ReadYesNo("Enable CSV output", BookOfVariables.CsvListsOutputEnabled);
                 
                 Console.WriteLine("\n=== Configuration Complete ===\n");
             }
             
             // Get input path with retry limit and escape key support
            string inputPath = string.Empty;
            const int maxAttempts = 20;
            int attempts = 0;
            
            while (attempts < maxAttempts)
            {
                Console.Write($"Enter path to CSV file or folder (attempt {attempts + 1}/{maxAttempts}, or press Esc to cancel): ");
                
                // Read key-by-key to detect Escape
                var input = new System.Text.StringBuilder();
                while (true)
                {
                    var key = Console.ReadKey(intercept: true);
                    
                    if (key.Key == ConsoleKey.Escape)
                    {
                        Console.WriteLine("\nOperation cancelled by user.");
                        return;
                    }
                    
                    if (key.Key == ConsoleKey.Enter)
                    {
                        Console.WriteLine();
                        break;
                    }
                    
                    if (key.Key == ConsoleKey.Backspace && input.Length > 0)
                    {
                        input.Remove(input.Length - 1, 1);
                        Console.Write("\b \b"); // Erase the character from console
                    }
                    else if (!char.IsControl(key.KeyChar))
                    {
                        input.Append(key.KeyChar);
                        Console.Write(key.KeyChar);
                    }
                }
                
                inputPath = input.ToString().Trim('"').Trim();
                
                if (!string.IsNullOrEmpty(inputPath) && (File.Exists(inputPath) || Directory.Exists(inputPath)))
                    break;
                    
                Console.WriteLine("Path not found or invalid. Please try again.");
                attempts++;
            }
            
            if (attempts >= maxAttempts)
            {
                Console.WriteLine("\nMaximum number of attempts reached. Exiting...");
                return;
            }
             
             // Process the input path
            if (string.IsNullOrEmpty(inputPath))
            {
                Console.WriteLine("No input path provided.");
                return;
            }
            
            if (Directory.Exists(inputPath))
             {
                 await ProcessDirectory(inputPath);
             }
             else if (File.Exists(inputPath) && inputPath.EndsWith(".csv", StringComparison.OrdinalIgnoreCase))
             {
                 await ProcessSingleFile(inputPath);
             }
             else
             {
                 Console.WriteLine("Unsupported file type. Please provide a .csv file or a directory.");
             }
         }
         
         private static async Task ProcessDirectory(string directoryPath)
        {
            try
            {
                // Use the directory itself as the output directory
                await Program.ProcessDirectory(directoryPath, directoryPath);
                Console.WriteLine("\nAll files processed successfully!");
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Error processing directory: {ex.Message}");
            }
        }
        
        private static async Task ProcessSingleFile(string filePath)
        {
            try
            {
                // Use the file's directory as the output directory
                string outputDir = Path.GetDirectoryName(filePath) ?? ".";
                await Program.ProcessFile(filePath, outputDir);
                Console.WriteLine($"Completed processing: {Path.GetFileName(filePath)}");
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Error processing {Path.GetFileName(filePath)}: {ex.Message}");
            }
        }
         
         // Helper methods for reading user input
         private static int ReadInt(string prompt, int defaultValue)
         {
             Console.Write($"{prompt} [{defaultValue}]: ");
             if (int.TryParse(Console.ReadLine(), out int result))
                 return result;
             return defaultValue;
         }
         
         private static uint ReadHexUInt(string prompt, uint defaultValue)
        {
            Console.Write($"{prompt} [0x{defaultValue:X}]: ");
            string? input = Console.ReadLine()?.Trim();
            if (string.IsNullOrEmpty(input))
                return defaultValue;
                
            if (input.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
                input = input[2..];
                
            if (uint.TryParse(input, System.Globalization.NumberStyles.HexNumber, null, out uint result))
                return result;
                
            return defaultValue;
        } 
         
         private static double ReadDouble(string prompt, double defaultValue)
        {
            Console.Write($"{prompt} [{defaultValue}]: ");
            string? input = Console.ReadLine();
            if (string.IsNullOrEmpty(input))
                return defaultValue;
                
            if (double.TryParse(input, out double result))
                return result;
                
            return defaultValue;
        } 
         
         private static bool ReadYesNo(string prompt, bool defaultValue)
         {
             string defaultValueStr = defaultValue ? "Y/n" : "y/N";
             Console.Write($"{prompt} [{defaultValueStr}]: ");
             string? input = Console.ReadLine()?.Trim().ToLower();
            return string.IsNullOrEmpty(input) ? defaultValue : input == "y" || input == "yes";
         }
     }
 }
