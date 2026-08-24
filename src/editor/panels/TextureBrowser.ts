import { inject, singleton } from 'tsyringe';
import { createIcons, icons } from 'lucide';
import TextureLibrary from '../TextureLibrary';

@singleton()
export default class TextureBrowser {
    private readonly container: HTMLElement;
    private readonly searchInput: HTMLInputElement;
    private readonly listContainer: HTMLElement;
    private readonly fileInput: HTMLInputElement;
    private visible = false;
    private searchTerm = '';

    public onHide: (() => void) | null = null;

    constructor(@inject(TextureLibrary) private readonly library: TextureLibrary) {
        this.container = document.createElement('aside');
        this.container.id = 'texture-browser';
        this.container.innerHTML = `
            <div class="tb-header">
                <div class="tb-heading">
                    <span class="tb-eyebrow">Assets</span>
                    <span class="tb-title">Texture Library</span>
                </div>
                <button class="tb-close" type="button" aria-label="Close"><i data-lucide="x"></i></button>
            </div>
            <div class="tb-actions">
                <button class="tb-upload" type="button"><i data-lucide="upload"></i> Upload textures</button>
                <input class="tb-search" type="search" placeholder="Search library…" aria-label="Search textures">
            </div>
            <div class="tb-drop-zone">
                <i data-lucide="image-up"></i>
                <strong>Drop image files here</strong>
                <span>PNG, JPG, WEBP and other browser formats</span>
            </div>
            <div class="tb-list"></div>
        `;
        document.body.appendChild(this.container);

        this.searchInput = this.container.querySelector('.tb-search') as HTMLInputElement;
        this.listContainer = this.container.querySelector('.tb-list') as HTMLElement;
        this.fileInput = document.createElement('input');
        this.fileInput.type = 'file';
        this.fileInput.accept = 'image/*';
        this.fileInput.multiple = true;
        this.fileInput.hidden = true;
        this.container.appendChild(this.fileInput);

        this.container.querySelector('.tb-close')?.addEventListener('click', () => this.hide());
        this.container.querySelector('.tb-upload')?.addEventListener('click', () => this.fileInput.click());
        this.fileInput.addEventListener('change', () => {
            void this.importFiles(this.fileInput.files);
            this.fileInput.value = '';
        });
        this.searchInput.addEventListener('input', () => {
            this.searchTerm = this.searchInput.value.trim().toLowerCase();
            this.render();
        });

        this.container.addEventListener('dragover', (event) => {
            // A texture dragged from this same library grid carries our own marker (see the
            // item's own dragstart) - the browser also synthesizes a dataTransfer.files entry
            // for it (the drag source is an <img> backed by a blob: URL), which would
            // otherwise look exactly like a real external file drop and re-import the asset
            // as a brand-new duplicate with a hash-derived filename. Ignore drags that carry
            // that marker; only a genuine external file drop should trigger an import.
            if (event.dataTransfer?.types.includes('application/x-santown-texture-path')) return;
            if (!event.dataTransfer?.types.includes('Files')) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
            this.container.classList.add('drag-over');
        });
        this.container.addEventListener('dragleave', (event) => {
            if (!this.container.contains(event.relatedTarget as Node | null)) {
                this.container.classList.remove('drag-over');
            }
        });
        this.container.addEventListener('drop', (event) => {
            if (event.dataTransfer?.types.includes('application/x-santown-texture-path')) return;
            if (!event.dataTransfer?.files.length) return;
            event.preventDefault();
            this.container.classList.remove('drag-over');
            void this.importFiles(event.dataTransfer.files);
        });

        this.library.onChanged = () => this.render();
        void this.library.ready().then(() => this.render());
        createIcons({ icons });
    }

    public get isVisible(): boolean { return this.visible; }

    public toggle(): void {
        if (this.visible) this.hide();
        else this.show();
    }

    public show(): void {
        this.visible = true;
        this.container.classList.add('visible');
        this.render();
    }

    public hide(): void {
        this.visible = false;
        this.container.classList.remove('visible');
        this.onHide?.();
    }

    private async importFiles(files: FileList | null): Promise<void> {
        if (!files) return;
        await this.library.addFiles(files);
        this.render();
    }

    private render(): void {
        this.listContainer.innerHTML = '';

        const missing = this.library.getMissingPaths();
        if (missing.length > 0) {
            const warning = document.createElement('section');
            warning.className = 'tb-missing';
            warning.innerHTML = `
                <div class="tb-missing-icon"><i data-lucide="triangle-alert"></i></div>
                <div><strong>${missing.length} missing texture${missing.length === 1 ? '' : 's'}</strong><span>Drop the original files here to relink them.</span></div>
            `;
            const paths = document.createElement('div');
            paths.className = 'tb-missing-paths';
            for (const path of missing.slice(0, 5)) {
                const item = document.createElement('code');
                item.textContent = path.split('/').pop() ?? path;
                item.title = path;
                paths.appendChild(item);
            }
            warning.appendChild(paths);
            this.listContainer.appendChild(warning);
        }

        const assets = this.library.getAssets().filter((asset) =>
            !this.searchTerm || asset.name.toLowerCase().includes(this.searchTerm) || asset.path.toLowerCase().includes(this.searchTerm),
        );

        if (assets.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'tb-empty';
            empty.innerHTML = this.searchTerm
                ? '<i data-lucide="search-x"></i><strong>No matching textures</strong><span>Try a different search.</span>'
                : '<i data-lucide="images"></i><strong>Your library is empty</strong><span>Upload or drop images to get started.</span>';
            this.listContainer.appendChild(empty);
            createIcons({ icons });
            return;
        }

        const grid = document.createElement('div');
        grid.className = 'tb-textures';
        for (const asset of assets) {
            const item = document.createElement('div');
            item.className = 'tb-texture';
            item.draggable = true;
            item.title = `Drag ${asset.name} onto a surface`;

            const image = document.createElement('img');
            image.src = asset.url;
            image.alt = asset.name;
            const name = document.createElement('span');
            name.className = 'tb-tex-name';
            name.textContent = asset.name;
            const path = document.createElement('span');
            path.className = 'tb-tex-path';
            path.textContent = asset.path;
            item.append(image, name, path);

            item.addEventListener('dragstart', (event) => {
                event.dataTransfer?.setData('application/x-santown-texture-path', asset.path);
                if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
            });
            grid.appendChild(item);
        }
        this.listContainer.appendChild(grid);
        createIcons({ icons });
    }
}
