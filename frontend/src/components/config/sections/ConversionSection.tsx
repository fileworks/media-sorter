import { FormRow } from "@/components/ui/form-row";
import { Toggle } from "@/components/ui/toggle";
import { Select, SelectItem } from "@/components/ui/select";
import { HELP } from "@/components/config/help";
import type { Config } from "@/types/api";
import type { SectionProps } from "@/components/config/constants";

export function ConversionSection({ config, updateConfig }: SectionProps) {
  return (
    <>
      <FormRow label="Convert images" htmlFor="convert-images" help={HELP.convertImages} inline>
        <Toggle
          id="convert-images"
          checked={config.convert_images ?? false}
          onChange={(v) => updateConfig({ convert_images: v })}
        />
      </FormRow>

      {(config.convert_images ?? false) && (
        <FormRow label="Image format" htmlFor="image-format">
          <Select
            id="image-format"
            value={config.image_format ?? "jpeg"}
            onValueChange={(v) => updateConfig({ image_format: v as Config["image_format"] })}
            className="max-w-xs"
          >
            <SelectItem value="jpeg">JPEG</SelectItem>
            <SelectItem value="png">PNG</SelectItem>
            <SelectItem value="webp">WebP</SelectItem>
            <SelectItem value="tiff">TIFF</SelectItem>
          </Select>
        </FormRow>
      )}

      <FormRow label="Convert videos" htmlFor="convert-videos" help={HELP.convertVideos} inline>
        <Toggle
          id="convert-videos"
          checked={config.convert_videos ?? false}
          onChange={(v) => updateConfig({ convert_videos: v })}
        />
      </FormRow>

      {(config.convert_videos ?? false) && (
        <FormRow label="Video format" htmlFor="video-format">
          <Select
            id="video-format"
            value={config.video_format ?? "mp4"}
            onValueChange={(v) => updateConfig({ video_format: v as Config["video_format"] })}
            className="max-w-xs"
          >
            <SelectItem value="mp4">MP4</SelectItem>
            <SelectItem value="mkv">MKV</SelectItem>
            <SelectItem value="mov">MOV</SelectItem>
            <SelectItem value="webm">WebM</SelectItem>
            <SelectItem value="avi">AVI</SelectItem>
          </Select>
        </FormRow>
      )}
    </>
  );
}
