// House styles, as a starting grade for the rules.
//
// The catalogue has one opinion per rule and it cannot have the right one for
// everybody: an I-frame playlist is advisory in RFC 8216 and required by Apple's
// authoring specification, and which of those you are held to depends on where the
// stream is going. A profile is that context, expressed in the only currency the
// extension has — severities.
//
// A profile is a starting point, not a policy. hlsLens.diagnostics.severity is
// applied on top of it, so a team can take the profile and still argue with one line
// of it.
import { SeverityOverride } from './analyze';

/** The profiles this extension knows, and what each one insists on. */
export const PROFILES: Record<string, Record<string, SeverityOverride>> = {
  // Apple's HLS Authoring Specification: what an App Store review actually checks.
  apple: {
    'master/no-iframe-stream': 'error',
    'master/missing-resolution': 'error',
    'master/average-bandwidth-missing': 'warning',
    'master/ladder-spacing': 'warning',
    'media/pdt-missing': 'warning',
    'master/codecs-resolution-mismatch': 'error',
  },
  // A stream sold as low latency: the advisory half of the LL vocabulary stops being
  // advisory, because without it the latency is not actually delivered.
  'low-latency': {
    'media/rendition-report-missing': 'warning',
    'media/holdback-too-small': 'error',
    'media/can-skip-until-too-small': 'warning',
    'media/preload-hint-not-preloading': 'warning',
    'media/pdt-missing': 'warning',
  },
};

/**
 * profileOverrides returns the grades of a named profile. An unknown name grades
 * nothing rather than throwing: this comes from a settings file, and a typo there
 * should leave the catalogue as it is, not stop the extension.
 */
export function profileOverrides(name: string): Record<string, SeverityOverride> {
  return PROFILES[name] ?? {};
}
