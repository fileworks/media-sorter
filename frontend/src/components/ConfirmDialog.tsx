import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "@/components/ui/modal";
import { useI18n } from "@/i18n/I18nContext";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "destructive" | "default";
  children?: ReactNode;
  onClose: () => void;
  onConfirm: () => void;
}

/** A question with two answers. Everything modal about it comes from `Modal`. */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel,
  variant = "destructive",
  children,
  onClose,
  onConfirm,
}: ConfirmDialogProps) {
  const { t } = useI18n();

  return (
    <Modal open={open} onClose={onClose} title={title} size="sm">
      <ModalHeader />
      <ModalBody>
        <p className="text-sm leading-relaxed text-muted-foreground">{description}</p>
        {children && <div className="mt-3">{children}</div>}
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" size="sm" onClick={onClose}>
          {cancelLabel ?? t("common.cancel")}
        </Button>
        <Button variant={variant} size="sm" onClick={onConfirm}>
          {confirmLabel ?? t("common.confirm")}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
