export type ManagedImageMediaType =
  | "image/jpeg"
  | "image/png"
  | "image/webp";

export interface InspectedImage {
  readonly mediaType: ManagedImageMediaType;
  readonly width: number;
  readonly height: number;
  readonly animated: boolean;
}

export interface ImageCropRectangle {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export type CardImageCropFallbackReason =
  | "subject-not-found"
  | "subject-too-small"
  | "foreground-too-sparse"
  | "background-not-confident"
  | "crop-too-aggressive"
  | "no-meaningful-empty-margin";

export type CardImageRendition =
  | {
      readonly outcome: "rendered";
      readonly bytes: Uint8Array;
      readonly mediaType: "image/webp";
      readonly width: number;
      readonly height: number;
      readonly crop: ImageCropRectangle;
      readonly fallbackReason: null;
    }
  | {
      readonly outcome: "unchanged";
      readonly bytes: Uint8Array;
      readonly mediaType: ManagedImageMediaType;
      readonly width: number;
      readonly height: number;
      readonly crop: null;
      readonly fallbackReason: CardImageCropFallbackReason;
    };

export interface StoredCardImageRendition {
  readonly mediaType: "image/webp";
  readonly bytes: Uint8Array;
}
