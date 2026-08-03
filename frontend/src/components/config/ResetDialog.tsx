import { Button } from "@/components/ui/button";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "@/components/ui/modal";
import { useI18n } from "@/i18n/I18nContext";

export interface ResetRow {
  setting: string;
  current: string;
  default: string;
}

interface ResetDialogProps {
  open: boolean;
  title: string;
  rows: ResetRow[];
  onClose: () => void;
  onConfirm: () => void;
}

/**
 * What a reset would change, before it changes it.
 *
 * Reset used to write new values and say nothing about what they replaced, so
 * the only way to find out what a reset had done was to remember what had been
 * there. Every reset path — all settings, one group, one row, and the
 * irreversible-recipe confirmation — renders this same table, and the values
 * are formatted by the same helpers the settings themselves use, never as raw
 * identifiers.
 *
 * Settings that would not change are omitted; a reset with nothing to do opens
 * no dialog at all.
 */
export function ResetDialog({ open, title, rows, onClose, onConfirm }: ResetDialogProps) {
  const { t } = useI18n();

  return (
    <Modal open={open} onClose={onClose} title={title} size="md">
      <ModalHeader />
      <ModalBody>
        {rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("config.reset.nothingToDo")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-border text-muted-foreground">
                  <th scope="col" className="py-1.5 pr-3 font-medium">
                    {t("config.reset.setting")}
                  </th>
                  <th scope="col" className="py-1.5 pr-3 font-medium">
                    {t("config.reset.current")}
                  </th>
                  <th scope="col" className="py-1.5 font-medium">
                    {t("config.reset.default")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.setting} className="border-b border-border last:border-0">
                    <td className="py-1.5 pr-3 text-foreground">{row.setting}</td>
                    <td className="py-1.5 pr-3 text-muted-foreground">{row.current}</td>
                    <td className="py-1.5 font-medium text-foreground">{row.default}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </ModalBody>
      <ModalFooter>
        <div className="flex w-full justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button disabled={rows.length === 0} onClick={onConfirm}>
            {t("config.reset.confirm", { count: rows.length })}
          </Button>
        </div>
      </ModalFooter>
    </Modal>
  );
}
