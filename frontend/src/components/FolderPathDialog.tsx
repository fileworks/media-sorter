/**
 * The folder picker for builds that do not have one.
 *
 * In the desktop shell "Change…" opens the OS dialog. In a browser there is no
 * OS dialog to open, and a button that does nothing is worse than one that asks
 * a question — so it asks for the path instead. The copy has always promised
 * this ("type the path instead"); this is the dialog that promise referred to.
 */

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "@/components/ui/modal";
import { useI18n } from "@/i18n/I18nContext";

interface FolderPathDialogProps {
  open: boolean;
  /** Prefilled when changing an existing folder rather than adding one. */
  initialPath?: string;
  onSubmit: (path: string) => void;
  onClose: () => void;
}

export function FolderPathDialog({
  open,
  initialPath = "",
  onSubmit,
  onClose,
}: FolderPathDialogProps) {
  const { t } = useI18n();
  const [path, setPath] = useState(initialPath);

  useEffect(() => {
    if (open) setPath(initialPath);
  }, [initialPath, open]);

  const trimmed = path.trim();
  const submit = () => {
    if (!trimmed) return;
    onSubmit(trimmed);
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title={t("sources.pathDialog.title")} size="md">
      <ModalHeader />
      <ModalBody className="space-y-2.5">
        <label className="block">
          <span className="text-xs font-semibold text-foreground">
            {t("sources.pathDialog.label")}
          </span>
          <input
            autoFocus
            value={path}
            spellCheck={false}
            onChange={(event) => setPath(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && submit()}
            placeholder={t("sources.pathDialog.placeholder")}
            className="mt-1.5 w-full rounded-lg border border-input bg-background px-3 py-2 font-mono text-xs text-foreground transition-colors placeholder:text-faint hover:border-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
        <p className="text-xs leading-relaxed text-faint">{t("sources.pathDialog.help")}</p>
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" size="sm" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button size="sm" disabled={!trimmed} onClick={submit}>
          {t("common.confirm")}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
