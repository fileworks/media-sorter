/**
 * Translation keys for configuration help. InfoTooltip resolves these through
 * the active locale so every caller stays declarative and user values remain
 * outside the translation system.
 */
export const HELP = {
  sortBy: "help.sortBy",
  cameraSubfolder: "help.cameraSubfolder",
  copyVsMove: "help.copyVsMove",
  renameFiles: "help.renameFiles",
  duplicateExact: "help.duplicateExact",
  duplicatePerceptual: "help.duplicatePerceptual",
  duplicateThreshold: "help.duplicateThreshold",
  dedupAgainstDestination: "help.dedupAgainstDestination",
  junkFilter: "help.junkFilter",
  junkMinSize: "help.junkMinSize",
  junkMinDimension: "help.junkMinDimension",
  junkPatterns: "help.junkPatterns",
  recursiveScan: "help.recursiveScan",
  minFileSize: "help.minFileSize",
  maxFileSize: "help.maxFileSize",
  excludePatterns: "help.excludePatterns",
  preserveSubfolders: "help.preserveSubfolders",
  overrideMetadata: "help.overrideMetadata",
  convertImages: "help.convertImages",
  convertVideos: "help.convertVideos",
  repair: "help.repair",
  aiTagging: "help.aiTagging",
  aiProvider: "help.aiProvider",
  aiEmbed: "help.aiEmbed",
  aiLabels: "help.aiLabels",
  categorize: "help.categorize",
  categorizeCategories: "help.categorizeCategories",
  categorizeConfidence: "help.categorizeConfidence",
  categorizeMargin: "help.categorizeMargin",
  aiModelTier: "help.aiModelTier",
  aiAllowGpu: "help.aiAllowGpu",
  aiConfidence: "help.aiConfidence",
} as const;
