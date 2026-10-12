/** Review and edit the content tags a run will write for one file. */

import { useState } from "react";
import { FiRotateCcw, FiX } from "react-icons/fi";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/i18n/I18nContext";
import { cleanTags, MAX_REVIEWED_TAG_LENGTH, MAX_REVIEWED_TAGS } from "@/lib/reviewTags";

interface TagEditorProps {
  /** The tags the run will write: the proposal, or Review's edit of it. */
  tags: string[];
  /** True once Review changed the proposal for this file. */
  edited: boolean;
  onChange: (tags: string[]) => void;
  onReset: () => void;
}

export function TagEditor({ tags, edited, onChange, onReset }: TagEditorProps) {
  const { t } = useI18n();
  const [draft, setDraft] = useState("");
  const full = tags.length >= MAX_REVIEWED_TAGS;

  const add = () => {
    const next = cleanTags([...tags, draft]);
    if (next.length > tags.length) onChange(next);
    setDraft("");
  };

  return (
    <section aria-labelledby="review-tags-title" className="border-t border-border px-3 py-3">
      <div className="flex items-center justify-between gap-2">
        <h3 id="review-tags-title" className="text-2xs font-semibold text-foreground">
          {t("review.tags.title")}
        </h3>
        {edited && (
          <Button size="sm" variant="ghost" onClick={onReset}>
            <FiRotateCcw className="h-3.5 w-3.5" aria-hidden />
            {t("review.tags.reset")}
          </Button>
        )}
      </div>
      <p className="mt-1 text-3xs text-muted-foreground">{t("review.tags.help")}</p>
      {tags.length === 0 ? (
        <p className="mt-2 text-3xs text-faint">{t("review.tags.none")}</p>
      ) : (
        <ul className="mt-2 flex flex-wrap gap-2" aria-label={t("review.tags.title")}>
          {tags.map((tag) => (
            <li
              key={tag}
              className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-muted py-0.5 pl-2 pr-1 text-3xs text-foreground"
            >
              <span className="min-w-0 break-words">{tag}</span>
              <button
                type="button"
                aria-label={t("review.tags.remove", { tag })}
                onClick={() => onChange(tags.filter((candidate) => candidate !== tag))}
                className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <FiX className="h-3 w-3" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="mt-2 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <Input
          aria-label={t("review.tags.add")}
          placeholder={t("review.tags.placeholder")}
          value={draft}
          maxLength={MAX_REVIEWED_TAG_LENGTH}
          disabled={full}
          onChange={(event) => setDraft(event.target.value)}
          className="h-8 min-w-0 flex-1 text-xs"
        />
        <Button type="submit" size="sm" variant="outline" disabled={full || draft.trim() === ""}>
          {t("review.tags.addButton")}
        </Button>
      </form>
    </section>
  );
}
