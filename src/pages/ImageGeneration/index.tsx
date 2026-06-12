import { ImageGenerationSettings } from '@/components/settings/ImageGenerationSettings';

export function ImageGenerationPage() {
  return (
    <div data-testid="image-generation-page" className="flex flex-col -m-6 dark:bg-background min-h-[calc(100vh-2.5rem)] overflow-hidden">
      <div className="clawx-page-container">
        <ImageGenerationSettings />
      </div>
    </div>
  );
}

export default ImageGenerationPage;
