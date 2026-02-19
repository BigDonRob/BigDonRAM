/**
 * =============================================================================
 * Achievement Generator - Updated for New Algorithm
 * Handles static lists with ghosts, dynamic lists, base pointers, entry points
 * =============================================================================
 */

class AchievementGenerator {
    constructor(systemId = 'n64') {
        this.systemId = systemId;
        this.systemConfig = Config.getSystemConfig(systemId);
        this.systemMask = this.systemConfig?.mask;
        this.use24Bit = this.systemConfig?.use24Bit || false;
        this.useBigEndian = (systemId === 'gamecube' || systemId === 'wii');
        this.targetAddresses = [];
        
        // Persistent ID counters
        this.staticId = 100000;
        this.targetId = 1000;
        this.regularId = 10000;
    }

    /**
     * Update system configuration
     */
    updateSystem(systemId) {
        this.systemId = systemId;
        this.systemConfig = Config.getSystemConfig(systemId);
        this.systemMask = this.systemConfig?.mask;
        this.use24Bit = this.systemConfig?.use24Bit || false;
        this.useBigEndian = (systemId === 'gamecube' || systemId === 'wii');
    }

    setTargetAddresses(targets) {
        this.targetAddresses = targets.filter(t => t !== null && t !== 0);
    }

    /**
     * Generate all achievements from structures
     */
    generateAchievements(structures) {
        const achievements = [];
        const targetAchievements = [];

        // Group by base pointer
        const basePointerGroups = new Map();
        
        for (const structure of structures) {
            let baseAddr = null;
            
            if (structure.type === 'static_list') {
                baseAddr = structure.addresses[0]; // First entry of static list
            } else if (structure.type === 'dynamic_list') {
                baseAddr = structure.root; // Base pointer for dynamic lists
            } else if (structure.type === 'entry_point') {
                baseAddr = structure.root; // Base pointer for entry points
            }
            
            if (baseAddr !== null) {
                if (!basePointerGroups.has(baseAddr)) {
                    basePointerGroups.set(baseAddr, {
                        entryPoints: [],
                        structures: [],
                        staticLists: []
                    });
                }
                
                if (structure.type === 'entry_point') {
                    basePointerGroups.get(baseAddr).entryPoints.push(structure);
                } else if (structure.type === 'dynamic_list') {
                    basePointerGroups.get(baseAddr).structures.push(structure);
                } else if (structure.type === 'static_list') {
                    basePointerGroups.get(baseAddr).staticLists.push(structure);
                }
            }
        }

        // Generate achievements for each base pointer
        for (const [baseAddr, group] of basePointerGroups) {
            if (group.entryPoints.length > 0) {
                // Filter out entry points with no offsets
                const validEntryPoints = group.entryPoints.filter(ep => ep.path && ep.path.length > 0);
                if (validEntryPoints.length > 0) {
                    const validGroup = { ...group, entryPoints: validEntryPoints };
                    const achievement = this.generateBasePointerWithEntryPointsAchievement(baseAddr, validGroup);
                    if (achievement) {
                        const coversTarget = this.checkTargetCoverageForGroup(validEntryPoints);
                        if (coversTarget) {
                            achievement.isTarget = true;
                            achievement.title += ' TARGET DETECTED';
                            targetAchievements.push(achievement);
                        } else {
                            achievements.push(achievement);
                        }
                    }
                }
            }
            
            if (group.structures.length > 0) {
                // Filter out structures with no offsets
                const validStructures = group.structures.filter(struct => struct.path && struct.path.length > 0);
                if (validStructures.length > 0) {
                    const validGroup = { ...group, structures: validStructures };
                    const achievement = this.generateBasePointerWithStructuresAchievement(baseAddr, validGroup);
                    if (achievement) {
                        const coversTarget = this.checkTargetCoverageForGroup(validStructures);
                        if (coversTarget) {
                            achievement.isTarget = true;
                            achievement.title += ' TARGET DETECTED';
                            targetAchievements.push(achievement);
                        } else {
                            achievements.push(achievement);
                        }
                    }
                }
            }
            
            if (group.staticLists.length > 0) {
                // Static list achievements (one per static list)
                for (const staticList of group.staticLists) {
                    const achievement = this.generateStaticListAchievement(staticList);
                    if (achievement) {
                        const coversTarget = this.checkTargetCoverage(staticList);
                        if (coversTarget) {
                            achievement.isTarget = true;
                            achievement.title += ' TARGET DETECTED';
                            targetAchievements.push(achievement);
                        } else {
                            achievements.push(achievement);
                        }
                    }
                }
            }
        }

        // Assign IDs: static lists start at 100,000, targets at 1,000, others at 10,000
        for (const ach of targetAchievements) {
            ach.id = this.targetId++;
        }

        for (const ach of achievements) {
            // Check if this is a static list achievement
            if (ach.title && ach.title.includes('Static List')) {
                ach.id = this.staticId++;
            } else {
                ach.id = this.regularId++;
            }
        }

        return [...targetAchievements, ...achievements];
    }

    /**
     * Check if structure covers target addresses
     */
    checkTargetCoverage(structure) {
        if (this.targetAddresses.length === 0) return false;

        // Get all addresses in structure
        const structureAddrs = new Set();
        
        if (structure.addresses) {
            for (const addr of structure.addresses) {
                structureAddrs.add(addr);
            }
        }
        
        if (structure.ghosts) {
            for (const addr of structure.ghosts) {
                structureAddrs.add(addr);
            }
        }

        // Check overlap
        for (const target of this.targetAddresses) {
            if (structureAddrs.has(target)) {
                return true;
            }
        }

        return false;
    }

    /**
     * Unified Static List achievement generation
     */
    generateStaticListAchievement(structure) {
        const idHex = structure.id.toString(16).toUpperCase();
        const rootHex = structure.root.toString(16).toUpperCase();
        
        // Calculate full range (including ghosts)
        const allAddresses = [...structure.addresses, ...structure.ghosts].sort((a, b) => a - b);
        const firstAddr = allAddresses[0];
        const lastAddr = allAddresses[allAddresses.length - 1];
        const range = lastAddr - firstAddr;
        const dwordCount = Math.floor(range / 4);
        
        const lastHex = lastAddr.toString(16).toUpperCase();

        // Generate DWORD checks only for actual node addresses
        const conditions = [];
        for (let i = 0; i < allAddresses.length; i++) {
            const addr = allAddresses[i];
            const addrHex = addr.toString(16);
            
            const prefix = i < allAddresses.length - 1 ? 'O:' : '';
            conditions.push(`${prefix}0xX${addrHex}!=d0xX${addrHex}`);
        }

        const logic = conditions.join('_');
        const ghostInfo = structure.ghostCount > 0 ? ` (${structure.ghostCount} ghosts)` : '';
        const title = `Static List 0x${idHex}${ghostInfo}`;
        const description = `${structure.validCount} nodes from 0x${rootHex} to 0x${lastHex}`;

        return { id: null, logic, title, description, isTarget: false, type: 'static_list' };
    }

    /**
     * Unified Non-Static achievement generation (dynamic lists, entry points, base pointers)
     */
    generateNonStaticAchievement(config) {
        const { 
            type, 
            id, 
            root, 
            path = [], 
            buildOffset = 0, 
            nodeCount, 
            stride, 
            targetStruct,
            entryPoints,
            structures,
            offsetInfo,
            additionalInfo = ''
        } = config;
        
        const idHex = id ? id.toString(16).toUpperCase() : 'UNK';
        const rootHex = root.toString(16).toUpperCase();
        const sizePrefix = this.getSizePrefix();
        const maskStr = this.getMaskString();
        
        const parts = [];
        
        // Base pointer check
        parts.push(`S${sizePrefix}${rootHex}=d${sizePrefix}${rootHex}`);
        
        // Handle different generation patterns
        if (type === 'dynamic_list') {
            // Dynamic list: navigate to buildOffset directly
            parts.push(`K:${sizePrefix}${rootHex}${maskStr}`);
            
            const dwordRange = Math.min(0xFC, stride || buildOffset);
            const dwordCount = Math.floor(dwordRange / 4);
            
            for (let i = 0; i < 0x3F; i += 4) {
                const offset = buildOffset + i;
                const offsetHex = offset.toString(16);
                const prefix = i < 0x3F- 4 ? 'O:' : '';
                parts.push(`I:{recall}_${prefix}0xX${offsetHex}!=d0xX${offsetHex}`);
            }
            
            const offsetHex = buildOffset.toString(16).toUpperCase();
            const title = `Dynamic List 0x${idHex} (0x${offsetHex})`;
            const description = `${nodeCount} nodes at offset 0x${offsetHex}`;
            
            return { id: null, logic: parts.join('_'), title, description, isTarget: false, type: 'dynamic_list' };
            
        } else if (type === 'base_pointer_with_alts') {
            // Base pointer with alternatives - each alt is a complete line, grouped together
            const alts = [];
            const altItems = entryPoints || structures;
            
            for (const item of altItems) {
                const altParts = [];
                const itemPath = [...(item.path || [])];
                
                // Each alt starts with base pointer check
                altParts.push(`S${sizePrefix}${rootHex}=d${sizePrefix}${rootHex}`);
                
                if (itemPath.length === 1) {
                    // Single offset - K: on base pointer address
                    altParts.push(`K:${sizePrefix}${rootHex}${maskStr}`);
                    const offset = itemPath[0];
                    for (let i = 0; i < 0x3F; i += 4) {
                        const dwordOffset = offset + i;
                        const dwordOffsetHex = dwordOffset.toString(16);
                        const prefix = i < 0x3F- 4 ? 'O:' : '';
                        altParts.push(`I:{recall}_${prefix}0xX${dwordOffsetHex}!=d0xX${dwordOffsetHex}`);
                    }
                } else if (itemPath.length > 1) {
                    // Multi-offset path: include root address in chain
                    altParts.push(`I:${sizePrefix}${rootHex}${maskStr}`);
                    
                    for (let j = 0; j < itemPath.length - 1; j++) {
                        const offset = itemPath[j];
                        const offsetHex = `${sizePrefix}${offset.toString(16)}`;
                        
                        if (j === itemPath.length - 2) {
                            altParts.push(`K:${offsetHex}${maskStr}`);
                        } else {
                            altParts.push(`I:${offsetHex}${maskStr}`);
                        }
                    }
                    
                    const finalOffset = itemPath[itemPath.length - 1];
                    for (let i = 0; i < 0x3F; i += 4) {
                        const offset = finalOffset + i;
                        const offsetHex = offset.toString(16);
                        const prefix = i < 0x3F- 4 ? 'O:' : '';
                        altParts.push(`I:{recall}_${prefix}0xX${offsetHex}!=d0xX${offsetHex}`);
                    }
                }
                
                alts.push(altParts.join('_'));
            }
            
            // Group all alts with underscores between them
            const logic = alts.join('_');
            const altType = entryPoints ? 'entry points' : 'dynamic structures';
            const title = `Base Pointer 0x${rootHex} (${altItems.length} ${altType})`;
            const description = `${altItems.length} ${altType} found from base 0x${rootHex}`;
            
            return { id: null, logic, title, description, isTarget: false, type: 'base_pointer_with_alts' };
            
        } else {
            // Entry point or base pointer: navigate through path
            const fullPath = [...path];
            
            if (fullPath.length === 1) {
                // Single offset - K: on base pointer address
                parts.push(`K:${sizePrefix}${rootHex}${maskStr}`);
                const offset = fullPath[0];
                for (let i = 0; i < 0x3F; i += 4) {
                    const dwordOffset = offset + i;
                    const dwordOffsetHex = dwordOffset.toString(16);
                    const prefix = i < 0x3F- 4 ? 'O:' : '';
                    parts.push(`I:{recall}_${prefix}0xX${dwordOffsetHex}!=d0xX${dwordOffsetHex}`);
                }
            } else {
                // Multi-offset path: include root address in chain
                parts.push(`I:${sizePrefix}${rootHex}${maskStr}`);
                
                for (let i = 0; i < fullPath.length - 1; i++) {
                    const offset = fullPath[i];
                    const offsetHex = `${sizePrefix}${offset.toString(16)}`;
                    
                    if (i === fullPath.length - 2) {
                        parts.push(`K:${offsetHex}${maskStr}`);
                    } else {
                        parts.push(`I:${offsetHex}${maskStr}`);
                    }
                }
                
                const finalOffset = fullPath[fullPath.length - 1];
                for (let i = 0; i < 0x3F; i += 4) {
                    const offset = finalOffset + i;
                    const offsetHex = offset.toString(16);
                    const prefix = i < 0x3F- 4 ? 'O:' : '';
                    parts.push(`I:{recall}_${prefix}0xX${offsetHex}!=d0xX${offsetHex}`);
                }
            }
            
            const logic = parts.join('_');
            let title, description;
            
            if (type === 'entry_point') {
                const offsetInfoStr = buildOffset ? `0x${buildOffset.toString(16)}` : '0x0';
                if (targetStruct) {
                    const targetType = targetStruct.type === 'static_list' ? 'Static' : 'Dynamic';
                    const targetNodeCount = targetStruct.nodeCount || nodeCount;
                    title = `Entry Point to ${targetType} Structure (${targetNodeCount} nodes, ${offsetInfoStr})`;
                } else {
                    title = `Entry Point 0x${idHex} (${offsetInfoStr})`;
                }
                description = `From base 0x${rootHex}, ${nodeCount} nodes at ${offsetInfoStr}`;
                if (targetStruct) {
                    description += `, Accesses: ${targetStruct.type}`;
                }
            } else {
                const offsetInfoStr = offsetInfo || (buildOffset ? `0x${buildOffset.toString(16)}` : '0x0');
                const hasMovingEntry = entryPoints && entryPoints.some(ep => ep.movingEntryPoint);
                const movingNote = hasMovingEntry ? ' MOVING' : '';
                title = `Base Pointer 0x${idHex} (${offsetInfoStr})${movingNote}`;
                description = `From 0x${rootHex}, ${nodeCount} nodes at ${offsetInfoStr}`;
                if (hasMovingEntry) {
                    description += ' - Entry point varies by state (progression/instance)';
                }
            }
            
            return { id: null, logic, title, description, isTarget: false, type: type };
        }
    }

    /**
     * Legacy wrapper for dynamic list achievement generation
     */
    generateDynamicListAchievement(structure) {
        return this.generateNonStaticAchievement({
            type: 'dynamic_list',
            id: structure.id,
            root: structure.root,
            buildOffset: structure.buildOffset,
            nodeCount: structure.nodeCount,
            stride: structure.stride
        });
    }

    /**
     * Legacy wrapper for base pointer with entry points achievement generation
     */
    generateBasePointerWithEntryPointsAchievement(baseAddr, group) {
        return this.generateNonStaticAchievement({
            type: 'base_pointer_with_alts',
            id: baseAddr,
            root: baseAddr,
            entryPoints: group.entryPoints
        });
    }

    /**
     * Legacy wrapper for base pointer with structures achievement generation
     */
    generateBasePointerWithStructuresAchievement(baseAddr, group) {
        return this.generateNonStaticAchievement({
            type: 'base_pointer_with_alts',
            id: baseAddr,
            root: baseAddr,
            structures: group.structures
        });
    }

    /**
     * Calculate smallest stride in structure
     */
    calculateSmallestStride(structure) {
        if (!structure.addresses || structure.addresses.length < 2) return 0xFC;
        
        let smallestStride = 0xFC;
        
        for (let i = 1; i < structure.addresses.length; i++) {
            const delta = structure.addresses[i] - structure.addresses[i-1];
            if (delta > 0 && delta < smallestStride) {
                smallestStride = delta;
            }
        }
        
        return Math.max(smallestStride, 4); // Minimum 4 bytes
    }

    /**
     * Check target coverage for group of structures
     */
    checkTargetCoverageForGroup(structures) {
        if (!this.targetAddresses || this.targetAddresses.length === 0) return false;
        
        const structureAddrs = new Set();
        
        for (const struct of structures) {
            if (struct.addresses) {
                for (const addr of struct.addresses) {
                    structureAddrs.add(addr);
                }
            }
        }
        
        for (const target of this.targetAddresses) {
            if (structureAddrs.has(target)) {
                return true;
            }
        }
        
        return false;
    }

    /**
     * Legacy wrapper for entry point achievement generation
     */
    generateEntryPointAchievement(entryPoint) {
        return this.generateNonStaticAchievement({
            type: 'entry_point',
            id: entryPoint.id,
            root: entryPoint.root,
            path: entryPoint.path,
            buildOffset: entryPoint.buildOffset,
            nodeCount: entryPoint.nodeCount,
            targetStruct: entryPoint.targetStruct
        });
    }

    /**
     * Legacy wrapper for base pointer achievement generation
     */
    generateBasePointerAchievement(structure) {
        return this.generateNonStaticAchievement({
            type: 'base_pointer',
            id: structure.id,
            root: structure.root,
            path: structure.entryPoints?.[0]?.path || [],
            buildOffset: structure.buildOffset,
            nodeCount: structure.nodeCount,
            entryPoints: structure.entryPoints,
            offsetInfo: structure.offsetInfo
        });
    }

    /**
     * Get size prefix based on system
     */
    getSizePrefix() {
        if (this.useBigEndian) {
            return '0xG'; // GameCube/Wii big-endian
        } else if (this.use24Bit) {
            return '0xW'; // 24-bit systems
        } else {
            return '0xX'; // Standard 32-bit
        }
    }

    /**
     * Get mask string for inline application
     */
    getMaskString() {
        if (this.systemMask === null) {
            return '';
        }
        return `&0x${this.systemMask.toString(16).toUpperCase()}`;
    }

    /**
     * Export achievements to .txt file
     */
    exportToTxt(achievements) {
        let output = '';
        output += '// ============================================================================\n';
        output += '// AUTO-GENERATED TEST ACHIEVEMENTS\n';
        output += `// Total achievements: ${achievements.length}\n`;
        output += '// ============================================================================\n\n';

        for (const ach of achievements) {
            const formatted = `${ach.id}:"${ach.logic}":${ach.title}:${ach.description}::::BigDonRob:0:::::00000`;
            output += formatted + '\n';
        }

        return output;
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { AchievementGenerator };
}
