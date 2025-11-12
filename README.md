# The BigDonRAM Pointer Analysis Tool

A powerful tool for analyzing pointer structures in memory dumps from various gaming platforms.

## Supported Platforms
- GameCube (GC)
- Wii (Wii)
- Game Boy Advance (GBA)
- Nintendo 64 (N64)
- Nintendo DS (NDS) (Use for NDSi as well)
- PlayStation 1 (PS1/PSX)
- PlayStation 2 (PS2)
- PlayStation Portable (PSP)
- Sega Dreamcast (DC)

## Memory Ranges
```
GC: 	0x80000000 - 0x817FFFFF
Wii: 	0x80000000 - 0x817FFFFF  (Mem1)
Wii: 	0x90000000 - 0x93FFFFFF  (Mem2)
GBA: 	0x02000000 - 0x0203FFFF  (EWRAM)
GBA: 	0x03000000 - 0x03007FFF  (IWRAM)
N64: 	0x80000000 - 0x807FFFFF
NDS: 	0x02000000 - 0x02FFFFFF
PS1: 	0x80000000 - 0x801FFFFF
PS2: 	0x00100000 - 0x01FFFFFF
PSP: 	0x08000000 - 0x0BFFFFFF
DC: 	0x8C000000 - 0x8CFFFFFF
```

## Usage
1. Start a new Search for 32-bit memory:
   - For GC and Wii: Use 32-bit Big-Endian (BE) ALIGNED memory
   - For all other systems ( GBA, N64, NDS, PSP, DC, PS2, PS1): Use 32-bit Little-Endian (LE) ALIGNED memory
2. Pause your emulator.
3. Make a save state.
4. Search for the ADDRESS range you want to investigate as a VALUE range, using Hardware addresses.
5. Export 1 or more CSVs, covering the ranges you want to investigate.

### Naming Convention
`GameName(Or Number)_SystemKey_1(2,3,4,etc.)`

Example: `Zelda_GC_1.csv`, `MarioKart_Wii_2.csv`, `30284_PSP_1.csv`

### Basic Usage
```
PointerAnalysis.exe <input_path> [options]
```

### Options
- `-i, --interactive`: Run in interactive mode to configure settings
- `-v, --verbose`: Enable verbose logging (shows all structures)(Not recommended for large games)
- `-o, --output <directory>`: Specify output directory (default: same as input)
- `--min-array <count>`: Set minimum array elements to show in non-verbose mode (default: 10)
- `--min-table <count>`: Set minimum hash table elements to show in non-verbose mode (default: 10)
- `--min-depth <depth>`: Set minimum tree depth to show in non-verbose mode (default: 5)
- `--no-advanced`: Disable advanced structure detection

### Examples
```
# Analyze a single file
PointerAnalysis.exe "C:\path\to\Zelda_GC_1.csv"

# Analyze all CSV files in a directory
PointerAnalysis.exe "C:\path\to\directory"

# Run in interactive mode
PointerAnalysis.exe -i

# Specify output directory
PointerAnalysis.exe "input.csv" -o "C:\output"
```

## How It Works
When a CSV is loaded:
1. All values outside the specified hardware address range are filtered out
2. Values are checked to be divisible by 4 to remove excess captured values
3. "Hot" values found in excessive quantities (default: 50+) are filtered out as likely bad values or object references

### Search Process
1. **Initial Scan**:
   - Identifies basic node info
   - Looks for self-reference nodes and backlink nodes within the SelfDoubleScanCap (default: 0x4-0x20)
   - Promotes likely list candidates to priority search
   - Removes found nodes from consideration to prevent overlap

2. **Graph Construction**:
   - Builds a database of nodes and their children at 0x(0,4,8,C,10,14,18,1C,20) offsets
   - Performs Depth-First Search (DFS) for each offset
   - Classifies and removes found lists from further searches
   - Repeats for all priority nodes, then all remaining nodes

3. **Entry Point Analysis**:
   - Only provides pointers directly pointing to nodes at the same offset as the list
   - Additional pointers to Entry Points may be found with manual investigations or other tools (Pointer Finder 2 by CySlaytor)

## Advanced Computation

The tool includes advanced structure detection capabilities for identifying complex memory structures:

### Detected Structures

#### Binary Trees
- **Description**: Hierarchical data structures where each node has up to two children (left and right)
- **Detection Process**:
  1. Identifies nodes with parent-child relationships
  2. Validates tree properties (no cycles, single parent per node)
  3. Calculates depth and balance factors
  4. Filters based on minimum depth and size thresholds
- **Common Uses**: Game object hierarchies, scene graphs, spatial partitioning

#### Pointer Tables
- **Description**: Arrays of pointers that reference similar memory regions
- **Detection Process**:
  1. Groups pointers with similar target memory regions
  2. Validates consistent spacing between elements
  3. Checks for common access patterns
  4. Filters based on minimum table size and element count
- **Common Uses**: Virtual function tables, object instance arrays, resource managers

#### Structure Arrays
- **Description**: Contiguous blocks of similar structures in memory
- **Detection Process**:
  1. Identifies repeated patterns in memory
  2. Verifies consistent stride between elements
  3. Validates structural similarity across elements
  4. Combines adjacent arrays when possible
- **Common Uses**: Game object pools, particle systems, level data

### Configuration Options

#### Verbose Logging Mode
- **Verbose Logging**: When enabled, shows all detected structures regardless of size
- **Non-Verbose Mode**: Filters results to show only significant structures:
  - Binary Trees: Minimum depth of 5
  - Arrays/Tables: Minimum of 10 elements

#### Interactive Configuration
When running in interactive mode (`-i` flag), you can configure:

**Basic Detection Settings**:
- **Verbose Logging**: Toggle detailed output
- **CSV Output**: Enable/disable CSV output
- **Search Ranges**: Configure memory search ranges
- **Pointer Validation**: Toggle strict pointer validation

**Structure Detection Thresholds**:
- **Minimum Structure Size**: Set minimum size for structure detection
- **Maximum Pointer Distance**: Adjust maximum distance for pointer validation (does not affect entry points)
- **Minimum List Length**: Set minimum length for list detection
- **Entry Point Settings**:
  - Maximum backward chain length (default: 6)
  - Chain discard threshold (default: 5)
  - Maximum list length for entry points (default: 500 in non-verbose mode, unlimited in verbose mode)

**Advanced Detection**:
- **Enable/Disable Advanced Detection**: Toggle advanced structure detection
- **Non-Verbose Thresholds**:
  - Minimum array elements to show (default: 10)
  - Minimum hash table elements to show (default: 10)
  - Minimum tree depth to show (default: 5)
- **Structure Detection**:
  - Enable/disable binary tree detection
  - Enable/disable pointer table detection
  - Enable/disable structure array detection

### How It Works
1. **Binary Tree Detection**:
   - Identifies parent-child relationships
   - Calculates tree depth and balance
   - Filters based on size and depth thresholds

2. **Pointer Table Detection**:
   - Groups pointers with similar target types
   - Validates table consistency
   - Applies size-based filtering

3. **Structure Array Detection**:
   - Identifies arrays of similar structures
   - Detects consistent strides between elements
   - Combines adjacent arrays when possible

## Output Files
For each input file, the tool generates:
- `<filename>_report.txt`: Basic analysis report
- `<filename>_advanced_report.txt`: Detailed advanced structure analysis
- `<filename>_summary.csv`: Detailed CSV output (if CSV output is enabled)

## Performance Notes
- **Verbose Logging**: Disabled by default to prevent excessive data generation with large games
- **Memory Usage**: Optimized for large memory dumps
- **Processing Speed**: Varies based on CSV size and system resources

## Requirements
- Windows 10/11 x64
- .NET 9.0 Runtime (included in self-contained package)

## License
The Unlicense

> Have at it, Boys and Gals. -BigDonRob
