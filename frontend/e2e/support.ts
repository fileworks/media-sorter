import { type Page, type Locator } from "@playwright/test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import type { OperationReport, PreviewResult } from "../src/types/api";
import type { PlanRecoveryResponse } from "../src/services/api";

const require = createRequire(import.meta.url);
const DEFAULT_CONFIG = (
  JSON.parse(
    readFileSync(new URL("../../contracts/config-defaults.json", import.meta.url), "utf-8"),
  ) as { config: Record<string, unknown> }
).config;

/** axe-core's browser bundle, already a dependency of the vitest a11y suite. */
const AXE_SOURCE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf-8");

/** A valid one-pixel PNG served by the authenticated thumbnail endpoint. */
const SYNTHETIC_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

/** A generated 16×16 H.264 MP4; unsupported Chromium codecs still use the honest fallback. */
const SYNTHETIC_MP4 = Buffer.from(
  "AAAAJGZ0eXBpc29tAAACAGlzb21pc282aXNvMmF2YzFtcDQxAAAC7W1vb3YAAABsbXZoZAAAAAAAAAAAAAAAAAAAA+gAAAAAAAEAAAEAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAHvdHJhawAAAFx0a2hkAAAAAwAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAAAQAAAAEAAAAAABi21kaWEAAAAgbWRoZAAAAAAAAAAAAAAAAAAAMgAAAAAAVcQAAAAAAC1oZGxyAAAAAAAAAAB2aWRlAAAAAAAAAAAAAAAAVmlkZW9IYW5kbGVyAAAAATZtaW5mAAAAFHZtaGQAAAABAAAAAAAAAAAAAAAkZGluZgAAABxkcmVmAAAAAAAAAAEAAAAMdXJsIAAAAAEAAAD2c3RibAAAAKpzdHNkAAAAAAAAAAEAAACaYXZjMQAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAQABAASAAAAEgAAAAAAAAAARVMYXZjNjIuMjguMTAxIGxpYngyNjQAAAAAAAAAAAAAABj//wAAADRhdmNDAWQACv/hABdnZAAKrNlewEQAAAMABAAAAwDIPEiWWAEABmjr48siwP34+AAAAAAQcGFzcAAAAAEAAAABAAAAEHN0dHMAAAAAAAAAAAAAABBzdHNjAAAAAAAAAAAAAAAUc3RzegAAAAAAAAAAAAAAAAAAABBzdGNvAAAAAAAAAAAAAAAobXZleAAAACB0cmV4AAAAAAAAAAEAAAABAAAAAAAAAAAAAAAAAAAAYnVkdGEAAABabWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAtaWxzdAAAACWpdG9vAAAAHWRhdGEAAAABAAAAAExhdmY2Mi4xMi4xMDEAAACobW9vZgAAABBtZmhkAAAAAAAAAAEAAACQdHJhZgAAACR0ZmhkAAAAOQAAAAEAAAAAAAADEQAAAgAAAALLAQEAAAAAABR0ZmR0AQAAAAAAAAAAAAAAAAAAUHRydW4AAAoFAAAABwAAALACAAAAAAACywAABAAAAAAMAAAKAAAAAAwAAAQAAAAADAAAAAAAAAAMAAACAAAAABIAAAYAAAAADAAAAgAAAAMhbWRhdAAAAq4GBf//qtxF6b3m2Ui3lizYINkj7u94MjY0IC0gY29yZSAxNjUgcjMyMjIgYjM1NjA1YSAtIEguMjY0L01QRUctNCBBVkMgY29kZWMgLSBDb3B5bGVmdCAyMDAzLTIwMjUgLSBodHRwOi8vd3d3LnZpZGVvbGFuLm9yZy94MjY0Lmh0bWwgLSBvcHRpb25zOiBjYWJhYz0xIHJlZj0zIGRlYmxvY2s9MTowOjAgYW5hbHlzZT0weDM6MHgxMTMgbWU9aGV4IHN1Ym1lPTcgcHN5PTEgcHN5X3JkPTEuMDA6MC4wMiBtaXhlZF9yZWY9MSBtZV9yYW5nZT0xNiBjaHJvbWFfbWU9MSB0cmVsbGlzPTEgOHg4ZGN0PTEgY3FtPTAgZGVhZHpvbmU9MjEsMTEgZmFzdF9wc2tpcD0xIGNocm9tYV9xcF9vZmZzZXQ9LTIgdGhyZWFkcz0xIGxvb2thaGVhZF90aHJlYWRzPTEgc2xpY2VkX3RocmVhZHM9MCBucj0wIGRlY2ltYXRlPTEgaW50ZXJsYWNlZD0wIGJsdXJheV9jb21wYXQ9MCBjb25zdHJhaW5lZF9pbnRyYT0wIGJmcmFtZXM9MyBiX3B5cmFtaWQ9MiBiX2FkYXB0PTEgYl9iaWFzPTAgZGlyZWN0PTEgd2VpZ2h0Yj0xIG9wZW5fZ29wPTAgd2VpZ2h0cD0yIGtleWludD0yNTAga2V5aW50X21pbj0yNSBzY2VuZWN1dD00MCBpbnRyYV9yZWZyZXNoPTAgcmNfbG9va2FoZWFkPTQwIHJjPWNyZiBtYnRyZWU9MSBjcmY9MjMuMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMDAAgAAAABVliIQAN//+4QP4FNdN/mOPQ9kBaMEAAAAIQZokbEM//uAAAAAIQZ5CeIX/wYEAAAAIAZ5hdEK/xIAAAAAIAZ5jakK/xIEAAAAOQZpmSahBaJlMFPCv/sEAAAAIAZ6FakK/xIEAAABDbWZyYQAAACt0ZnJhAQAAAAAAAAEAAAAAAAAAAQAAAAAAAAQAAAAAAAAAAxEBAQEAAAAQbWZybwAAAAAAAABD",
  "base64",
);

/** Minimum tap-target side in CSS pixels — WCAG 2.5.8 Level AA. */
export const MIN_TARGET_PX = 24;

/**
 * A complete synthetic plan covering every media state later-stage approval
 * must disclose. The bytes served below are synthetic too; no personal library
 * path or network media is involved.
 */
/**
 * The scan the fixture plan was built from.
 *
 * Stored with the plan, as the app stores it: a restored plan carries its scan,
 * so no screen can claim the folders were never scanned while the stepper says
 * every stage is complete.
 */
export const E2E_ANALYSIS = {
  total_files: 6,
  total_size_bytes: 18_874_368,
  by_type: { image: 5, video: 1 },
  date_range: { earliest: null, latest: null, no_date_estimate: 0 },
  disk_space: {
    source_size_bytes: 18_874_368,
    destination_free_bytes: 64_000_000_000,
    sufficient: true,
    mode: "copy",
  },
  excluded_files: 0,
  estimated_duration_seconds: 120,
  warnings: [],
  partial: false,
  issues: [],
};

export const E2E_PREVIEW_RESULT: PreviewResult = {
  config_fingerprint: "e2e-config",
  plan_id: "e2e-plan",
  impact: {
    actionable_groups: 6,
    copy_count: 6,
    move_count: 0,
    quarantine_count: 0,
    quarantine_bytes: 0,
    skip_count: 0,
    source_mutations: 0,
    required_bytes: 18_874_368,
    conversion_without_originals: 0,
    companions_left_in_place: 0,
    embedded_tag_count: 0,
    unresolved_count: 0,
  },
  items: [
    {
      source: "/tmp/e2e-input/IMG_0001.jpg",
      destination: "/tmp/e2e-output/2026/08/IMG_0001.jpg",
      extracted_date: "2026-08-21T10:00:00Z",
      metadata_source: "exif",
      tags: ["synthetic"],
      status: "sort",
      file_size: 4_200_000,
      source_root: "/tmp/e2e-input",
      unit_id: "unit-live-photo",
      unit_primary: true,
      companions: [
        {
          source: "/tmp/e2e-input/IMG_0001.xmp",
          destination: "/tmp/e2e-output/2026/08/IMG_0001.xmp",
          role: "edit_sidecar",
          status: "attached",
          warning: null,
          extracted_date: "2026-08-21T10:00:00Z",
          placement_date_source: "primary",
        },
        {
          source: "/tmp/e2e-input/IMG_0001.mov",
          destination: "/tmp/e2e-output/2026/08/IMG_0001.mov",
          role: "motion_part",
          status: "attached",
          warning: "Motion metadata is unknown; the original bytes stay attached.",
          extracted_date: "2026-08-21T10:00:00Z",
          placement_date_source: "primary",
        },
      ],
      unit_warnings: ["One companion has incomplete metadata."],
    },
    {
      source: "/tmp/e2e-input/IMG_0001-copy.jpg",
      destination: "/tmp/e2e-output/_duplicates/IMG_0001-copy.jpg",
      would_be_destination: "/tmp/e2e-output/2026/08/IMG_0001-copy.jpg",
      extracted_date: "2026-08-21T10:00:00Z",
      metadata_source: "filesystem",
      tags: [],
      status: "duplicate",
      file_size: 3_900_000,
      duplicate_type: "exact",
      duplicate_similarity: 100,
      duplicate_of: "/tmp/e2e-input/IMG_0001.jpg",
      duplicate_evaluation: "known",
      source_root: "/tmp/e2e-input",
    },
    {
      source: "/tmp/e2e-input/synthetic.heic",
      destination: "/tmp/e2e-output/2026/08/synthetic.heic",
      extracted_date: "2026-08-20T09:00:00Z",
      metadata_source: "exif",
      tags: [],
      status: "sort",
      file_size: 5_100_000,
      source_root: "/tmp/e2e-input",
    },
    {
      source: "/tmp/e2e-input/synthetic.dng",
      destination: "/tmp/e2e-output/2026/08/synthetic.dng",
      extracted_date: "2026-08-19T08:00:00Z",
      metadata_source: "filename",
      tags: [],
      status: "sort",
      file_size: 4_800_000,
      source_root: "/tmp/e2e-input",
    },
    {
      source: "/tmp/e2e-input/synthetic.mp4",
      destination: "/tmp/e2e-output/2026/08/synthetic.mp4",
      extracted_date: null,
      metadata_source: "unknown",
      tags: [],
      status: "sort",
      file_size: 850_000,
      source_root: "/tmp/e2e-input",
    },
    {
      source: "/tmp/e2e-input/corrupt.jpg",
      destination: null,
      extracted_date: null,
      metadata_source: "unknown",
      tags: [],
      status: "failed",
      file_size: 24,
      source_root: "/tmp/e2e-input",
    },
  ],
  stats: {
    total: 6,
    will_sort: 4,
    will_fail: 1,
    will_quarantine_unknown: 0,
    will_quarantine_future: 0,
    will_skip_duplicate: 1,
    will_quarantine_junk: 0,
    will_skip_already_in_destination: 0,
    uncategorized: 1,
    eligible_media: 6,
    media_units: 5,
    companions: 2,
    companion_split_warnings: 1,
  },
  partial: false,
  issues: [],
};

export const E2E_RECOVERY: PlanRecoveryResponse = {
  plan_id: E2E_PREVIEW_RESULT.plan_id,
  config_fingerprint: E2E_PREVIEW_RESULT.config_fingerprint,
  destination_fingerprint: "e2e-destination",
  source_fingerprints: { "input-1": "e2e-source" },
  reviewed_sets: [],
};

/**
 * A plan with several duplicate sets, for exercising the decision workflow.
 *
 * The single-set fixture cannot show a queue advancing, and the sticky bars in
 * Resolve are exactly the kind of thing jsdom cannot judge: a button covered by
 * an overlay still "clicks" there, and only a real browser refuses.
 */
export function duplicatePlan(sets = 3) {
  const fact = (value: unknown) => ({ known: true, value, issue: null });
  const groups = Array.from({ length: sets }, (_, index) => {
    const n = index + 1;
    const members = [0, 1].map((m) => ({
      member_id: `dup${n}-m${m}`,
      root_id: "input-1",
      role: "input",
      relative_path: `DSC_${1000 + n}${m === 0 ? "" : "-copy"}.jpg`,
      observed_path: `/tmp/e2e-input/DSC_${1000 + n}${m === 0 ? "" : "-copy"}.jpg`,
      facts: {
        size_bytes: 4_000_000 - m * 100_000,
        modified_at: fact("2026-08-21T10:00:00Z"),
        captured_at: fact("2026-08-21T10:00:00Z"),
        width: fact(4032 - m * 100),
        height: fact(3024 - m * 100),
        duration_seconds: { known: false, value: null, issue: "not a video" },
        codec: { known: false, value: null, issue: "not recorded" },
        media_kind: "image",
      },
      evidence: {
        algorithm: "sha256",
        sha256: `dup-${n}`,
        signature: null,
        distance: 0,
        threshold: 0,
        confidence: "high",
        extraction_issues: [],
      },
    }));
    return {
      group_id: `dup-set-${n}`,
      kind: "exact",
      catalog_generation: 1,
      rule_version: "e2e-v1",
      member_count: 2,
      total_bytes: 7_900_000,
      anchor_member_id: `dup${n}-m0`,
      evidence_summary: "Identical content hashes.",
      members,
    };
  });

  const items = groups.flatMap((group) =>
    group.members.map((member, index) => ({
      source: member.observed_path,
      destination:
        index === 0
          ? `/tmp/e2e-output/2026/08/${member.relative_path}`
          : `/tmp/e2e-output/_copies/2026/08/${member.relative_path}`,
      extracted_date: "2026-08-21T10:00:00Z",
      metadata_source: "exif",
      tags: [],
      status: index === 0 ? "sort" : "duplicate",
      file_size: member.facts.size_bytes,
      source_root: "/tmp/e2e-input",
      unit_id: null,
      unit_primary: true,
      companions: [],
    })),
  );

  const result = {
    ...E2E_PREVIEW_RESULT,
    items: [...E2E_PREVIEW_RESULT.items, ...items],
  } as PreviewResult;

  return { groups, result };
}

export const E2E_OPERATION_REPORT: OperationReport = {
  operation_id: "e2e-operation",
  execution_date: "2026-08-21",
  started_at: "2026-08-21T10:00:00Z",
  finished_at: "2026-08-21T10:00:01Z",
  outcome: "completed",
  run_mode: "organize",
  transfer_mode: "move",
  source_path: "/tmp/e2e-input",
  source_roots: [
    { root_id: "input-1", role: "input", path: "/tmp/e2e-input", display_name: "Input" },
  ],
  dest_path: "/tmp/e2e-output",
  duration_seconds: 1,
  summary: {
    total: 8,
    sorted: 6,
    failed: 1,
    skipped: 1,
    remaining: 1,
    duplicates: 1,
    future_dates: 0,
    unknown_dates: 0,
    corrupted: 1,
    companions: 2,
    incomplete_units: 1,
    unmatched_companions: 0,
  },
  files: [
    operationFile("file-jpeg", "/tmp/e2e-input/IMG_0001.jpg", {
      destination: "/tmp/e2e-output/2026/08/IMG_0001.jpg",
      unitId: "unit-live-photo",
      primary: "/tmp/e2e-input/IMG_0001.jpg",
    }),
    operationFile("file-xmp", "/tmp/e2e-input/IMG_0001.xmp", {
      destination: "/tmp/e2e-output/2026/08/IMG_0001.xmp",
      unitId: "unit-live-photo",
      role: "edit_sidecar",
      primary: "/tmp/e2e-input/IMG_0001.jpg",
    }),
    operationFile("file-motion", "/tmp/e2e-input/IMG_0001.mov", {
      destination: "/tmp/e2e-output/2026/08/IMG_0001.mov",
      unitId: "unit-live-photo",
      role: "motion_part",
      primary: "/tmp/e2e-input/IMG_0001.jpg",
      error: "Motion metadata remained unknown; original bytes were retained.",
    }),
    operationFile("file-heic", "/tmp/e2e-input/synthetic.heic", {
      destination: "/tmp/e2e-output/2026/08/synthetic.heic",
    }),
    operationFile("file-raw", "/tmp/e2e-input/synthetic.dng", {
      destination: "/tmp/e2e-output/2026/08/synthetic.dng",
    }),
    operationFile("file-video", "/tmp/e2e-input/synthetic.mp4", {
      destination: "/tmp/e2e-output/2026/08/synthetic.mp4",
    }),
    operationFile("file-duplicate", "/tmp/e2e-input/IMG_0001-copy.jpg", {
      destination: null,
      status: "skipped_duplicate",
    }),
    operationFile("file-corrupt", "/tmp/e2e-input/corrupt.jpg", {
      destination: null,
      status: "failed",
      error: "Synthetic corrupt image could not be decoded.",
    }),
  ],
};

function operationFile(
  id: string,
  source: string,
  options: {
    destination: string | null;
    status?: string;
    unitId?: string;
    role?: string;
    primary?: string;
    error?: string;
  },
): OperationReport["files"][number] {
  return {
    id,
    operation_id: "e2e-operation",
    source_path: source,
    dest_path: options.destination,
    extracted_date: source.endsWith(".mp4") || source.includes("corrupt") ? null : "2026-08-21",
    metadata_source: source.endsWith(".mp4") || source.includes("corrupt") ? "unknown" : "exif",
    action: options.destination === null ? "leave" : "copy",
    status: options.status ?? (options.error ? "incomplete_unit" : "sorted"),
    error_message: options.error ?? null,
    file_size: 1,
    file_type: source.split(".").pop() ?? "unknown",
    tags: [],
    unit_id: options.unitId ?? null,
    companion_role: options.role ?? null,
    unit_primary_path: options.primary ?? null,
  };
}

export interface ContrastViolation {
  id: string;
  impact: string | null;
  help: string;
  nodes: { target: string[]; failureSummary: string | null }[];
}

/**
 * Run axe in the page, restricted to the rules jsdom cannot evaluate.
 *
 * Scoping to `color-contrast` is deliberate rather than lazy: running the full
 * rule set here would duplicate the vitest suite, and a duplicated assertion
 * that drifts is worse than one that lives in a single place.
 */
export async function contrastViolations(page: Page): Promise<ContrastViolation[]> {
  await page.evaluate(AXE_SOURCE);
  return page.evaluate(async () => {
    /** Only the shape this helper reads, so `any` is never needed. */
    interface AxeNode {
      target: string[];
      failureSummary?: string;
    }
    interface AxeViolation {
      id: string;
      impact?: string;
      help: string;
      nodes: AxeNode[];
    }
    interface AxeRun {
      run(context: Document, options: unknown): Promise<{ violations: AxeViolation[] }>;
    }
    const results = await (window as unknown as { axe: AxeRun }).axe.run(document, {
      runOnly: { type: "rule", values: ["color-contrast"] },
      resultTypes: ["violations"],
    });
    return results.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact ?? null,
      help: violation.help,
      nodes: violation.nodes.map((node) => ({
        target: node.target,
        failureSummary: node.failureSummary ?? null,
      })),
    }));
  });
}

export interface ObscuredTarget {
  label: string;
  coveredBy: string;
}

/**
 * WCAG 2.4.11 — is any part of the focused control covered by something else?
 *
 * Hit-testing the focused element's own corners and centre is what makes this a
 * *layout* check. A sticky header that overlaps a control only when the page is
 * scrolled is invisible to any test that reasons about the DOM alone, which is
 * precisely the failure this criterion exists for.
 */
export async function focusObscuredBy(page: Page): Promise<ObscuredTarget | null> {
  return page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    if (!active || active === document.body) return null;
    const box = active.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return null;

    const describe = (element: Element): string => {
      const tag = element.tagName.toLowerCase();
      const id = element.id ? `#${element.id}` : "";
      const cls =
        typeof element.className === "string" && element.className
          ? `.${element.className.trim().split(/\s+/).slice(0, 2).join(".")}`
          : "";
      return `${tag}${id}${cls}`;
    };
    const label = (active.textContent ?? "").trim().slice(0, 40) || describe(active);

    // Inset by a pixel so a shared border does not read as an overlap.
    const points: [number, number][] = [
      [box.left + 1, box.top + 1],
      [box.right - 1, box.top + 1],
      [box.left + 1, box.bottom - 1],
      [box.right - 1, box.bottom - 1],
      [box.left + box.width / 2, box.top + box.height / 2],
    ];
    for (const [x, y] of points) {
      if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) continue;
      const hit = document.elementFromPoint(x, y);
      if (!hit) continue;
      if (hit === active || active.contains(hit) || hit.contains(active)) continue;
      return { label, coveredBy: describe(hit) };
    }
    return null;
  });
}

export interface UndersizedTarget {
  label: string;
  width: number;
  height: number;
}

/**
 * WCAG 2.5.8 — every pointer target is at least 24x24 CSS pixels.
 *
 * Exempt, per the criterion itself: targets in a sentence of text, and controls
 * an equivalent of which exists elsewhere on the page. Neither exemption is
 * guessed at here — inline targets are detected by their line box, and anything
 * else that is genuinely exempt is expected to be listed by the caller.
 */
export async function undersizedTargets(
  page: Page,
  selector = "button, a[href], input, select, [role='button'], [role='tab'], [role='checkbox'], [role='switch']",
): Promise<UndersizedTarget[]> {
  return page.evaluate(
    ({ selector, minimum }) => {
      const out: { label: string; width: number; height: number }[] = [];
      for (const element of Array.from(document.querySelectorAll(selector))) {
        const node = element as HTMLElement;
        // 2.5.8 measures the *target* — the region that accepts the pointer
        // action — not the painted control. A 16px checkbox inside a label that
        // activates it has the label's box as its target, and reporting the
        // input would be a false positive. Noise is how an a11y suite earns
        // being ignored, so the distinction is made here rather than waved at.
        const wrappingLabel = node.closest("label");
        const explicitLabel =
          node.id === ""
            ? null
            : document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(node.id)}"]`);
        const associatedLabel = wrappingLabel ?? explicitLabel;
        const inputType = node instanceof HTMLInputElement ? node.type : "";
        const ownBox = node.getBoundingClientRect();
        const labelBox = associatedLabel?.getBoundingClientRect() ?? null;
        // A full-size checkbox/switch is already an equivalent target for its
        // associated text. A tiny native box delegates to the label instead.
        const box =
          (inputType === "checkbox" || inputType === "radio") &&
          (ownBox.width < minimum || ownBox.height < minimum) &&
          labelBox !== null
            ? labelBox
            : ownBox;
        if (box.width === 0 || box.height === 0) continue; // not rendered
        const style = getComputedStyle(node);
        if (style.visibility === "hidden" || style.display === "none") continue;
        if (node.hasAttribute("disabled")) continue;
        // Inline exemption: a link inside a run of text is explicitly excluded.
        if (style.display === "inline" && node.closest("p, li, span, label")) continue;
        if (box.width >= minimum && box.height >= minimum) continue;
        const text = (node.textContent ?? "").trim().slice(0, 40);
        const label =
          text ||
          node.getAttribute("aria-label") ||
          node.getAttribute("title") ||
          `${node.tagName.toLowerCase()}#${node.id || "?"}`;
        out.push({ label, width: Math.round(box.width), height: Math.round(box.height) });
      }
      return out;
    },
    { selector, minimum: MIN_TARGET_PX },
  );
}

/** Walk focus forward with Tab, yielding each stop. Bounded, so a focus trap ends the walk. */
export async function* tabStops(page: Page, limit = 60): AsyncGenerator<Locator> {
  const seen = new Set<string>();
  for (let index = 0; index < limit; index += 1) {
    await page.keyboard.press("Tab");
    const id = await page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      if (!active || active === document.body) return null;
      return `${active.tagName}:${active.id}:${(active.textContent ?? "").trim().slice(0, 24)}`;
    });
    if (id === null) return;
    if (seen.has(id)) return; // cycled back to the start
    seen.add(id);
    yield page.locator(":focus");
  }
}

/**
 * Serve the whole API from the page's own network layer.
 *
 * In dev, `api.ts` falls back to 127.0.0.1:8000 when Tauri IPC is absent, so
 * this is where the app's requests actually go.
 */
export async function stubBackend(page: Page): Promise<void> {
  const fixtureDefaults = configPayload();
  let currentConfig: Record<string, unknown> | undefined;
  const getDefaults = async (): Promise<Record<string, unknown>> => {
    return fixtureDefaults;
  };
  const getConfig = async (): Promise<Record<string, unknown>> => {
    if (!currentConfig) {
      currentConfig = { ...(await getDefaults()) };
    }
    return currentConfig;
  };

  await page.route("**/127.0.0.1:8000/**", async (route) => {
    const url = route.request().url();
    const body = (payload: unknown) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(payload),
      });
    const requestPath = new URL(url).searchParams.get("path") ?? "";
    // The fixture owns the entire browser flow, including the backend proofs
    // that make a configured root ready and the completed plan used by Review.
    // Keep specific routes before the `/api/config` prefix.
    if (url.includes("/api/config/validate"))
      return body({ valid: true, errors: [], warnings: [] });
    if (url.includes("/api/config/defaults")) return body(await getDefaults());
    if (url.includes("/api/config/sections")) return body({ sections: [] });
    if (url.includes("/api/config/recipes")) return body([]);
    if (url.includes("/api/fs/list"))
      return body({
        path: new URL(url).searchParams.get("path") ?? "/tmp",
        parent: "/tmp",
        exists: true,
        readable: true,
        writable: true,
        entries: [],
      });
    if (url.includes("/api/config")) {
      if (route.request().method() === "POST") {
        const patch = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
        currentConfig = { ...(await getConfig()), ...patch };
      }
      return body(await getConfig());
    }
    if (url.includes("/api/health")) return body({ status: "ok", version: "e2e" });
    if (url.includes("/api/ai/models")) return body({ packs: [] });
    if (url.includes("/api/diagnostics"))
      return body({ recovery_operations: [], active_task: null });
    if (url.includes("/api/media/info")) {
      const video = /\.(mov|mp4)$/i.test(requestPath);
      const corrupt = requestPath.endsWith("corrupt.jpg");
      return body({
        width: video || corrupt ? null : requestPath.endsWith("IMG_0001.jpg") ? 4032 : 3024,
        height: video || corrupt ? null : requestPath.endsWith("IMG_0001.jpg") ? 3024 : 4032,
        file_size: corrupt ? 24 : null,
        extracted_date: video || corrupt ? null : "2026-08-21T10:00:00Z",
        metadata_source: video || corrupt ? "unknown" : "exif",
        media_type: video ? "video" : corrupt ? "other" : "image",
        duration_seconds: video ? null : undefined,
        codec: video ? null : undefined,
      });
    }
    if (url.includes("/api/media/content")) {
      if (requestPath.endsWith("corrupt.jpg"))
        return route.fulfill({ status: 415, body: "synthetic corrupt media" });
      return route.fulfill({ status: 200, contentType: "video/mp4", body: SYNTHETIC_MP4 });
    }
    if (url.includes("/api/thumbnail")) {
      if (requestPath.endsWith("corrupt.jpg") || /\.(mov|mp4)$/i.test(requestPath))
        return route.fulfill({ status: 415, body: "thumbnail unavailable" });
      return route.fulfill({ status: 200, contentType: "image/png", body: SYNTHETIC_PNG });
    }
    if (url.includes("/api/sorting/plans/e2e-plan/recovery")) return body(E2E_RECOVERY);
    if (url.includes("/api/sorting/impact")) return body(E2E_PREVIEW_RESULT.impact);
    if (url.includes("/api/sorting/start")) return body({ task_id: "e2e-sort" });
    if (url.includes("/api/sorting/e2e-sort"))
      return body({
        task_id: "e2e-sort",
        operation_kind: "sort",
        status: "completed",
        progress: { current: 0, total: 0, percentage: 100, outcomes: {} },
        partial: false,
        issues: [],
        events: [],
        last_event_sequence: 0,
        error: null,
        failure: null,
        result: { operation_id: E2E_OPERATION_REPORT.operation_id, sorted: 0, failed: 0 },
      });
    if (url.includes(`/api/reports/${E2E_OPERATION_REPORT.operation_id}`))
      return body(E2E_OPERATION_REPORT);
    if (url.includes("/api/reports")) return body({ operations: [], total: 0 });
    if (url.includes("/api/recipes")) return body([]);
    if (url.includes("/api/review/groups"))
      return body({
        groups: new URL(url).searchParams.get("kind") === "exact" ? [e2eExactGroup()] : [],
        next_cursor: null,
        kind: new URL(url).searchParams.get("kind") ?? "exact",
        truncated: false,
        partial_index: false,
      });
    if (url.includes("/api/tasks")) return body([]);
    if (url.includes("/api/history")) return body([]);
    return body({});
  });
}

function e2eExactGroup() {
  const fact = (known: boolean, value: unknown, issue: string | null = null) => ({
    known,
    value: known ? value : null,
    issue,
  });
  const member = (
    member_id: string,
    observed_path: string,
    size_bytes: number,
    width: number | null,
    height: number | null,
    modifiedKnown = true,
  ) => ({
    member_id,
    root_id: "input-1",
    role: "input",
    relative_path: observed_path.replace("/tmp/e2e-input/", ""),
    observed_path,
    facts: {
      size_bytes,
      modified_at: fact(modifiedKnown, "2026-08-21T10:00:00Z", "modification date unavailable"),
      captured_at: fact(true, "2026-08-21T10:00:00Z"),
      width: fact(width !== null, width, "resolution unavailable"),
      height: fact(height !== null, height, "resolution unavailable"),
      duration_seconds: fact(false, null, "not a video"),
      codec: fact(false, null, "not recorded"),
      media_kind: "image",
    },
    evidence: {
      algorithm: "sha256",
      sha256: "e2e-identical-content",
      signature: null,
      distance: 0,
      threshold: 0,
      confidence: "high",
      extraction_issues: width === null ? ["resolution unavailable"] : [],
    },
  });
  return {
    group_id: "e2e-exact-set",
    kind: "exact",
    catalog_generation: 1,
    rule_version: "e2e-v1",
    member_count: 2,
    total_bytes: 8_100_000,
    anchor_member_id: "e2e-primary",
    evidence_summary: "Synthetic files have identical content hashes.",
    members: [
      member("e2e-primary", "/tmp/e2e-input/IMG_0001.jpg", 4_200_000, 4032, 3024),
      member("e2e-copy", "/tmp/e2e-input/IMG_0001-copy.jpg", 3_900_000, null, null, false),
    ],
  };
}

function configPayload(): Record<string, unknown> {
  // The app's complete fixture comes from the generated backend-defaults
  // contract. Resolving it in the Playwright worker keeps route callbacks
  // independent of the page lifetime during teardown.
  const base = DEFAULT_CONFIG;
  const profile = (base.library_profile ?? {}) as Record<string, unknown>;
  const root = (root_id: string, role: string, path: string, priority: number) => ({
    root_id,
    role,
    path,
    display_name: null,
    priority,
    exclusions: [],
    identity: null,
  });
  // The fixture ships `roots: []`, which leaves the Sources stage incomplete
  // and every later stage disabled — so an audit using it unmodified can only
  // ever see the first screen. Populating a valid input/destination pair is
  // what lets this suite reach Configure at all.
  return {
    ...base,
    source_directory: "/tmp/e2e-input",
    target_directory: "/tmp/e2e-output",
    library_profile: {
      ...profile,
      roots: [
        root("input-1", "input", "/tmp/e2e-input", 0),
        root("dest-1", "destination", "/tmp/e2e-output", 1),
      ],
    },
  };
}
