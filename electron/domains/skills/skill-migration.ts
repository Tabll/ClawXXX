import type { CanonicalSkill } from '@shared/domains/skills';
import type { LocalSkillRecord } from '../../services/skills/local-skill-service';
import type { CanonicalSkillService } from './skill-service';

/**
 * Idempotently adopts legacy OpenClaw Skills. Existing canonical desired state
 * is preserved; a changed native package only advances its content revision.
 */
export async function ensureCanonicalSkillCatalog(input: {
  service: CanonicalSkillService;
  scanOpenClawSkills: () => Promise<LocalSkillRecord[]>;
}): Promise<CanonicalSkill[]> {
  const records = await input.scanOpenClawSkills();
  const imported: CanonicalSkill[] = [];
  for (const record of records) {
    if (!record.baseDir) continue;
    const existing = await input.service.findBySlug(record.slug || record.id, true);
    imported.push(await input.service.importLocalSkill(record, {
      installedForKernels: existing?.installedForKernels ?? ['openclaw'],
      enabledForKernels: existing?.enabledForKernels ?? (record.enabled ? ['openclaw'] : []),
    }));
  }
  return imported;
}
