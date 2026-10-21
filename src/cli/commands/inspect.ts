import { allowedToolsOf, loadSkillSource } from '../../manifest/parse.js';
import { validateManifest } from '../../manifest/validate.js';
import { permissionCeiling, tierForTrust } from '../../admission/tier.js';
import { EXIT, writeJson } from '../shared.js';

export interface InspectOptions {
  dir: string;
  json: boolean;
}

export async function inspectCommand(options: InspectOptions): Promise<number> {
  const source = await loadSkillSource(options.dir);
  const tier = tierForTrust(source.manifest.trust);
  const summary = {
    name: source.manifest.name,
    version: source.manifest.version,
    trust: source.manifest.trust,
    trustTier: tier,
    capabilities: source.manifest.capabilities,
    requires: source.manifest.requires,
    conflicts: source.manifest.conflicts,
    permissions: source.manifest.permissions,
    scripts: source.scripts,
    allowedTools: allowedToolsOf(source.skillMd.frontmatter),
    eval: source.manifest.eval ?? 'cases',
    ceiling: permissionCeiling(tier),
    manifestIssues: validateManifest(source.manifest),
  };

  if (options.json) {
    writeJson(summary);
    return EXIT.ok;
  }

  console.log(`${summary.name}@${summary.version}  trust: ${summary.trust} (${summary.trustTier})`);
  console.log(`capabilities: ${summary.capabilities.join(', ')}`);
  console.log(`scripts: ${summary.scripts.length === 0 ? '<none>' : summary.scripts.join(', ')}`);
  console.log(`exec: ${summary.permissions.exec.length === 0 ? '<none>' : summary.permissions.exec.join(' | ')}`);
  console.log(`net: ${summary.permissions.net.length === 0 ? '<none>' : summary.permissions.net.join(', ')}`);
  console.log(`data: ${summary.permissions.data.length === 0 ? '<none>' : summary.permissions.data.join(', ')}`);
  console.log(
    `ceiling: exec=${summary.ceiling.exec} net=${summary.ceiling.net} fs=${summary.ceiling.fs} data=${summary.ceiling.data.join(',') || '<none>'}`,
  );
  for (const issue of summary.manifestIssues) {
    console.log(`  [manifest] ${issue.field}: ${issue.message}`);
  }
  return EXIT.ok;
}
