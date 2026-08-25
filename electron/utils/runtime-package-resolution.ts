import { createRequire } from 'node:module';
import { join } from 'node:path';
import { getOpenClawDir, getOpenClawResolvedDir } from './paths';

export type RuntimeModuleResolver = {
  label: string;
  resolve(specifier: string): string;
};

export function resolveModulePathWithFallbacks(
  specifier: string,
  resolvers: RuntimeModuleResolver[],
): string {
  const errors: string[] = [];

  for (const resolver of resolvers) {
    try {
      return resolver.resolve(specifier);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${resolver.label}: ${message}`);
    }
  }

  throw new Error(
    `Failed to resolve "${specifier}" from any runtime context. ${errors.join(' | ')}`,
  );
}

function getRuntimeModuleResolvers(): RuntimeModuleResolver[] {
  const seen = new Set<string>();
  const resolvers: RuntimeModuleResolver[] = [];
  const add = (label: string, getBase: () => string | URL) => {
    let base: string | URL;
    try {
      base = getBase();
    } catch {
      // An optional runtime can be absent while the base app still owns the
      // dependency (for example QR rendering during kernel onboarding).
      return;
    }
    const candidate = { label, base };
    const key = typeof candidate.base === 'string' ? candidate.base : candidate.base.toString();
    if (seen.has(key)) return;
    seen.add(key);

    const runtimeRequire = createRequire(candidate.base);
    resolvers.push({
      label: candidate.label,
      resolve: runtimeRequire.resolve.bind(runtimeRequire),
    });
  };

  add('openclaw-resolved', () => join(getOpenClawResolvedDir(), 'package.json'));
  add('openclaw', () => join(getOpenClawDir(), 'package.json'));
  add('app', () => import.meta.url);

  return resolvers;
}

export function resolveOpenClawRuntimeModulePath(specifier: string): string {
  return resolveModulePathWithFallbacks(specifier, getRuntimeModuleResolvers());
}
