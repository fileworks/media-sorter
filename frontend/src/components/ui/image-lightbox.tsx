/**
 * One file, as large as the window allows.
 *
 * The full preview modal exists for a `PreviewItem` — it has the dates, the
 * provenance, the destination. Plenty of places show a thumbnail of something
 * that is not a preview item (a duplicate group member, a diff render), and
 * there the only question is "let me actually look at it". This answers that
 * and nothing else, so the two are not confused for each other.
 */

import { MediaImage } from "@/components/ui/media-image";
import { Modal, ModalBody, ModalHeader } from "@/components/ui/modal";

interface ImageLightboxProps {
  /** A ready-to-render media URL — a thumbnail render, a diff, anything. */
  src: string;
  /** The dialog's accessible name, normally the file's basename. */
  title: string;
  onClose: () => void;
}

export function ImageLightbox({ src, title, onClose }: ImageLightboxProps) {
  return (
    <Modal open onClose={onClose} title={title} size="xl" className="bg-background">
      <ModalHeader />
      <ModalBody className="relative flex items-center justify-center px-3 py-3">
        <MediaImage
          src={src}
          alt={title}
          className="max-h-[70dvh] w-auto max-w-full rounded-lg object-contain"
        />
      </ModalBody>
    </Modal>
  );
}
