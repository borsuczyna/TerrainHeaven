import textureData from '../data/textures.json';

const BASE_URL = 'https://files.prineside.com/gtasa_samp_game_texture//png/';

export default class TextureBrowser {
    private container: HTMLElement;
    private searchInput: HTMLInputElement;
    private listContainer: HTMLElement;
    private visible = false;
    private openDicts: Set<string> = new Set();
    private dictNames: string[];
    private searchTerm = '';

    constructor() {
        this.dictNames = Object.keys(textureData);

        this.container = document.createElement('div');
        this.container.id = 'texture-browser';
        document.body.appendChild(this.container);

        // Header
        const header = document.createElement('div');
        header.className = 'tb-header';
        header.innerHTML = '<span class="tb-title">Texture Browser</span>';
        const closeBtn = document.createElement('button');
        closeBtn.className = 'tb-close';
        closeBtn.textContent = '\u00d7';
        closeBtn.addEventListener('click', () => this.hide());
        header.appendChild(closeBtn);
        this.container.appendChild(header);

        // Search
        this.searchInput = document.createElement('input');
        this.searchInput.type = 'text';
        this.searchInput.className = 'tb-search';
        this.searchInput.placeholder = 'Search textures...';
        this.searchInput.addEventListener('input', () => {
            this.searchTerm = this.searchInput.value.toLowerCase();
            this.render();
        });
        this.container.appendChild(this.searchInput);

        // List
        this.listContainer = document.createElement('div');
        this.listContainer.className = 'tb-list';
        this.container.appendChild(this.listContainer);
    }

    public toggle(): void {
        if (this.visible) {
            this.hide();
        } else {
            this.show();
        }
    }

    public show(): void {
        this.visible = true;
        this.container.classList.add('visible');
        this.render();
        this.searchInput.focus();
    }

    public hide(): void {
        this.visible = false;
        this.container.classList.remove('visible');
    }

    private render(): void {
        this.listContainer.innerHTML = '';
        const data = textureData as Record<string, string[]>;

        for (const dictName of this.dictNames) {
            const textures = data[dictName];
            const search = this.searchTerm;

            // Filter: match dict name or any texture name
            if (search) {
                const dictMatch = dictName.toLowerCase().includes(search);
                const anyTexMatch = textures.some(t => t.toLowerCase().includes(search));
                if (!dictMatch && !anyTexMatch) continue;
            }

            const dictEl = document.createElement('div');
            dictEl.className = 'tb-dict';

            const isOpen = this.openDicts.has(dictName);

            // Dict header
            const headerEl = document.createElement('div');
            headerEl.className = 'tb-dict-header';
            headerEl.innerHTML = `<span class="tb-arrow${isOpen ? ' open' : ''}">&#9654;</span>${this.highlight(dictName)} <span class="tb-count">(${textures.length})</span>`;
            headerEl.addEventListener('click', () => {
                if (this.openDicts.has(dictName)) {
                    this.openDicts.delete(dictName);
                } else {
                    this.openDicts.add(dictName);
                }
                this.render();
            });
            dictEl.appendChild(headerEl);

            // Texture list (only if open)
            if (isOpen) {
                const listEl = document.createElement('div');
                listEl.className = 'tb-textures';

                for (const texName of textures) {
                    if (search && !dictName.toLowerCase().includes(search) && !texName.toLowerCase().includes(search)) {
                        continue;
                    }

                    const texEl = document.createElement('div');
                    texEl.className = 'tb-texture';
                    texEl.draggable = true;

                    const imgSrc = `${BASE_URL}${encodeURIComponent(dictName)}.${encodeURIComponent(texName)}.png`;

                    const img = document.createElement('img');
                    img.loading = 'lazy';
                    img.src = imgSrc;
                    img.alt = texName;
                    img.addEventListener('error', () => {
                        img.style.display = 'none';
                    });

                    texEl.addEventListener('dragstart', (e) => {
                        e.dataTransfer?.setData('application/x-texture-url', imgSrc);
                        e.dataTransfer!.effectAllowed = 'copy';

                        // Custom drag ghost
                        const ghost = document.createElement('div');
                        ghost.className = 'tb-drag-ghost';
                        const ghostImg = document.createElement('img');
                        ghostImg.src = imgSrc;
                        ghost.appendChild(ghostImg);
                        const ghostLabel = document.createElement('span');
                        ghostLabel.textContent = texName;
                        ghost.appendChild(ghostLabel);
                        document.body.appendChild(ghost);
                        e.dataTransfer!.setDragImage(ghost, 32, 32);
                        requestAnimationFrame(() => ghost.remove());
                    });

                    const label = document.createElement('span');
                    label.className = 'tb-tex-name';
                    label.innerHTML = this.highlight(texName);

                    texEl.appendChild(img);
                    texEl.appendChild(label);
                    listEl.appendChild(texEl);
                }

                dictEl.appendChild(listEl);
            }

            this.listContainer.appendChild(dictEl);
        }
    }

    private highlight(text: string): string {
        if (!this.searchTerm) return text;
        const idx = text.toLowerCase().indexOf(this.searchTerm);
        if (idx < 0) return text;
        const before = text.slice(0, idx);
        const match = text.slice(idx, idx + this.searchTerm.length);
        const after = text.slice(idx + this.searchTerm.length);
        return `${before}<mark>${match}</mark>${after}`;
    }
}
