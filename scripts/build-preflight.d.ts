export function readPackageJson(packageJsonUrl: string | URL): Promise<{ dependencies?: Record<string, string> }>;

export function hasInstalledPackage(
  dependencyName: string,
  options?: {
    accessFile?: (path: string) => Promise<void>;
    resolvePaths?: (dependencyName: string) => string[] | null;
  },
): Promise<boolean>;

export function findMissingRuntimeDependencies(
  dependencies: Record<string, string> | undefined,
  options?: {
    accessFile?: (path: string) => Promise<void>;
    resolvePaths?: (dependencyName: string) => string[] | null;
  },
): Promise<string[]>;

export function findMissingPackageJsonRuntimeDependencies(packageJsonUrl: string | URL): Promise<string[]>;

export function formatMissingRuntimeDependenciesMessage(missingDependencies: string[]): string;
