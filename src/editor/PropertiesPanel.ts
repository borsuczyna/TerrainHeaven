import * as THREE from 'three';
import { singleton, inject } from 'tsyringe';
import type { PropertyDefinition, PropertyVector3, PropertyNumber, PropertyBoolean, PropertySelect, PropertyButton, SectionItem } from './Properties';
import type WorldElement from '../elements/WorldElement';
import CopyManager from './CopyManager';
import HistoryManager from './HistoryManager';
import { createIcons, icons } from 'lucide';
import PresetManager from './PresetManager';
import ToolManager from './ToolManager';

@singleton()
export default class PropertiesPanel {
    private container: HTMLElement;
    private element: WorldElement | null = null;
    private refreshInterval: number | null = null;
    private customDef: PropertyDefinition | null = null;
    private readonly copyManager: CopyManager;
    private readonly history: HistoryManager;
    // Custom select dropdowns are rendered into document.body (a "portal") so they aren't
    // clipped by the panel's own overflow-y:auto - only one can be open at a time, so
    // closing it just means tearing this down and clearing the reference.
    private openSelectDropdown: { close: () => void } | null = null;

    constructor(
        @inject(CopyManager) copyManager: CopyManager,
        @inject(HistoryManager) history: HistoryManager,
        @inject(PresetManager) private readonly presets: PresetManager,
        @inject(ToolManager) private readonly toolManager: ToolManager,
    ) {
        this.copyManager = copyManager;
        this.history = history;
        this.container = document.getElementById('properties-panel')!;
    }

    public show(element: WorldElement): void {
        if (this.element) {
            this.element.onPropertiesChanged = null;
        }
        this.customDef = null;
        this.element = element;
        this.element.onPropertiesChanged = () => this.render();
        this.render();
        this.container.classList.add('visible');

        // Auto-refresh values while visible
        if (this.refreshInterval) clearInterval(this.refreshInterval);
        this.refreshInterval = window.setInterval(() => this.refreshValues(), 100);
    }

    public showCustom(def: PropertyDefinition): void {
        if (this.element) {
            this.element.onPropertiesChanged = null;
            this.element = null;
        }
        this.customDef = def;
        this.render();
        this.container.classList.add('visible');

        if (this.refreshInterval) clearInterval(this.refreshInterval);
        this.refreshInterval = null;
    }

    public hide(): void {
        if (this.element) {
            this.element.onPropertiesChanged = null;
        }
        this.element = null;
        this.container.classList.remove('visible');
        this.container.innerHTML = '';
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
            this.refreshInterval = null;
        }
    }

    private render(): void {
        const def = this.customDef ?? this.element?.getProperties();
        if (!def) return;

        this.openSelectDropdown?.close();
        this.openSelectDropdown = null;

        let html = `<div class="panel-header"><span class="icon">${def.icon}</span><span class="panel-heading"><span class="panel-eyebrow">Inspector</span><span class="panel-title">${def.title}</span></span><div class="panel-header-actions"><button class="panel-delete-btn" data-tooltip="Delete selection" type="button"><i data-lucide="trash-2"></i></button><button class="panel-menu-btn" data-tooltip="More options" type="button"><i data-lucide="ellipsis"></i></button></div><div class="panel-menu" style="display:none"></div></div>`;

        for (const section of def.sections) {
            html += `<div class="section">`;
            html += `<div class="section-header" data-section="${section.label}">`;
            html += `<span class="arrow">&#9660;</span>${section.label}</div>`;
            html += `<div class="section-body" data-section-body="${section.label}">`;

            for (const prop of section.properties) {
                html += this.renderProperty(prop, section.label);
            }

            html += `</div></div>`;
        }

        this.container.innerHTML = html;
        createIcons({ icons });
        this.bindEvents(def);
        this.bindMenuEvents();
    }

    private renderProperty(prop: SectionItem, sectionLabel: string): string {
        const id = `${sectionLabel}-${prop.label}`.replace(/\s+/g, '-').toLowerCase();

        if (prop.type === 'button') {
            return `
                <div class="prop-row" data-prop-id="${id}" data-prop-type="button">
                    <button class="prop-button">${prop.label}</button>
                </div>`;
        }

        if (prop.type === 'vector3') {
            const v = prop.get();
            return `
                <div class="prop-row" data-prop-id="${id}" data-prop-type="vector3">
                    <span class="prop-label">${prop.label}</span>
                    <div class="prop-fields">
                        <div class="prop-field">
                            <span class="axis-label x">X</span>
                            <input type="number" step="0.1" value="${v.x.toFixed(3)}" data-axis="x" class="draggable-number">
                        </div>
                        <div class="prop-field">
                            <span class="axis-label y">Y</span>
                            <input type="number" step="0.1" value="${v.y.toFixed(3)}" data-axis="y" class="draggable-number">
                        </div>
                        <div class="prop-field">
                            <span class="axis-label z">Z</span>
                            <input type="number" step="0.1" value="${v.z.toFixed(3)}" data-axis="z" class="draggable-number">
                        </div>
                    </div>
                </div>`;
        }

        if (prop.type === 'number') {
            const v = prop.get();
            const step = prop.step ?? 1;
            const min = prop.min !== undefined ? `min="${prop.min}"` : '';
            const max = prop.max !== undefined ? `max="${prop.max}"` : '';
            return `
                <div class="prop-row" data-prop-id="${id}" data-prop-type="number">
                    <span class="prop-label">${prop.label}</span>
                    <div class="prop-fields">
                        <div class="prop-field-single">
                            <input type="number" step="${step}" ${min} ${max} value="${v}" class="draggable-number">
                        </div>
                    </div>
                </div>`;
        }

        if (prop.type === 'boolean') {
            const checked = prop.get() ? 'checked' : '';
            return `
                <div class="prop-row" data-prop-id="${id}" data-prop-type="boolean">
                    <span class="prop-label">${prop.label}</span>
                    <div class="prop-fields">
                        <div class="prop-field-single">
                            <input type="checkbox" ${checked}>
                        </div>
                    </div>
                </div>`;
        }

        if (prop.type === 'select') {
            const v = prop.get();
            const selectedLabel = prop.options.find(o => o.value === v)?.label ?? '';
            return `
                <div class="prop-row" data-prop-id="${id}" data-prop-type="select">
                    <span class="prop-label">${prop.label}</span>
                    <div class="prop-fields">
                        <div class="prop-field-single">
                            <button type="button" class="prop-select-btn" data-value="${v}">
                                <span class="prop-select-value">${selectedLabel}</span>
                                <i data-lucide="chevron-down"></i>
                            </button>
                        </div>
                    </div>
                </div>`;
        }

        return '';
    }

    private bindMenuEvents(): void {
        const btn = this.container.querySelector('.panel-menu-btn') as HTMLElement;
        const deleteButton = this.container.querySelector('.panel-delete-btn') as HTMLButtonElement;
        const menu = this.container.querySelector('.panel-menu') as HTMLElement;

        deleteButton.addEventListener('click', () => {
            window.dispatchEvent(new CustomEvent('delete-selection'));
        });

        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isOpen = menu.style.display !== 'none';
            menu.style.display = isOpen ? 'none' : 'block';

            if (!isOpen) {
                const canPaste = this.element !== null && this.copyManager.canPastePropertiesOnto(this.element);

                menu.innerHTML = `
                    <div class="panel-menu-item" data-action="copy">Copy properties</div>
                    <div class="panel-menu-item${canPaste ? '' : ' disabled'}" data-action="paste">Paste properties</div>
                    <div class="panel-menu-item" data-action="save-preset">Save as preset…</div>
                `;

                menu.querySelectorAll('.panel-menu-item').forEach(item => {
                    item.addEventListener('click', (ev) => {
                        ev.stopPropagation();
                        const action = (item as HTMLElement).dataset.action;
                        if (action === 'copy') this.doCopyProperties();
                        else if (action === 'paste' && canPaste) {
                            this.doPasteProperties();
                            this.history.record('Paste Properties');
                        }
                        else if (action === 'save-preset') this.savePreset();
                        menu.style.display = 'none';
                    });
                });
            }
        });

        document.addEventListener('click', () => {
            menu.style.display = 'none';
        }, { once: true, capture: true });
    }

    private doCopyProperties(): void {
        if (!this.element) return;
        this.copyManager.copyProperties(this.element);
    }

    private doPasteProperties(): void {
        if (!this.element) return;
        this.copyManager.pastePropertiesOnto(this.element);
    }

    private savePreset(): void {
        if (!this.element) return;
        const suggested = `${this.element.getProperties().title} Preset`;
        const name = window.prompt('Preset name', suggested);
        if (name === null) return;
        this.presets.savePreset(name, this.element);
        this.toolManager.setActive('presets');
    }

    private bindEvents(def: PropertyDefinition): void {
        // Section collapse/expand
        this.container.querySelectorAll('.section-header').forEach((header) => {
            header.addEventListener('click', () => {
                const label = (header as HTMLElement).dataset.section!;
                const body = this.container.querySelector(`[data-section-body="${label}"]`) as HTMLElement;
                const arrow = header.querySelector('.arrow') as HTMLElement;
                body.classList.toggle('hidden');
                arrow.classList.toggle('collapsed');
            });
        });

        // Property inputs
        const allProps = def.sections.flatMap(s => s.properties.map(p => ({ sectionLabel: s.label, prop: p })));

        for (const { sectionLabel, prop } of allProps) {
            const id = `${sectionLabel}-${prop.label}`.replace(/\s+/g, '-').toLowerCase();
            const row = this.container.querySelector(`[data-prop-id="${id}"]`);
            if (!row) continue;

            if (prop.type === 'vector3') {
                const inputs = row.querySelectorAll('input');
                const historyLabel = `Edit ${prop.label}`;
                const commit = () => {
                    const x = parseFloat((inputs[0] as HTMLInputElement).value) || 0;
                    const y = parseFloat((inputs[1] as HTMLInputElement).value) || 0;
                    const z = parseFloat((inputs[2] as HTMLInputElement).value) || 0;
                    (prop as PropertyVector3).set(new THREE.Vector3(x, y, z));
                };
                inputs.forEach((input) => {
                    input.addEventListener('focus', () => this.beginHistory(row as HTMLElement, historyLabel));
                    input.addEventListener('change', commit);
                    input.addEventListener('change', () => this.endHistory(row as HTMLElement, historyLabel));
                    input.addEventListener('blur', () => this.endHistory(row as HTMLElement, historyLabel));
                    this.attachNumberDrag(input as HTMLInputElement, () => parseFloat((input as HTMLInputElement).value) || 0, (next) => {
                        (input as HTMLInputElement).value = next.toFixed(3);
                        commit();
                    });
                });
            }

            if (prop.type === 'number') {
                const input = row.querySelector('input')!;
                const historyLabel = `Edit ${prop.label}`;
                const commitNumber = (finalize: boolean) => {
                    const rawValue = input.value.trim();
                    if (rawValue === '' || rawValue === '-' || rawValue === '.' || rawValue === '-.') {
                        if (!finalize) return;
                    }

                    const parsed = Number(rawValue);
                    if (!Number.isFinite(parsed)) {
                        if (!finalize) return;
                        input.value = String((prop as PropertyNumber).get());
                        return;
                    }

                    let nextValue = parsed;
                    if (!finalize) {
                        if (prop.min !== undefined && nextValue < prop.min) return;
                        if (prop.max !== undefined && nextValue > prop.max) return;
                    } else {
                        if (prop.min !== undefined) nextValue = Math.max(prop.min, nextValue);
                        if (prop.max !== undefined) nextValue = Math.min(prop.max, nextValue);
                        input.value = String(nextValue);
                    }

                    (prop as PropertyNumber).set(nextValue);
                };
                input.addEventListener('focus', () => this.beginHistory(row as HTMLElement, historyLabel));
                input.addEventListener('change', () => commitNumber(true));
                input.addEventListener('input', () => commitNumber(false));
                input.addEventListener('change', () => this.endHistory(row as HTMLElement, historyLabel));
                input.addEventListener('blur', () => commitNumber(true));
                input.addEventListener('blur', () => this.endHistory(row as HTMLElement, historyLabel));
                this.attachNumberDrag(
                    input as HTMLInputElement,
                    () => (prop as PropertyNumber).get(),
                    (next) => {
                        (input as HTMLInputElement).value = String(next);
                        (prop as PropertyNumber).set(next);
                    },
                    prop.min, prop.max, prop.step,
                );
            }

            if (prop.type === 'boolean') {
                const input = row.querySelector('input')!;
                input.addEventListener('change', () => {
                    const historyLabel = `Edit ${prop.label}`;
                    this.history.beginAction(historyLabel);
                    (prop as PropertyBoolean).set((input as HTMLInputElement).checked);
                    this.history.endAction(historyLabel);
                });
            }

            if (prop.type === 'button') {
                const btn = row.querySelector('button')!;
                btn.addEventListener('click', () => {
                    this.history.beginAction(prop.label);
                    (prop as PropertyButton).onClick();
                    this.history.endAction(prop.label);
                });
            }

            if (prop.type === 'select') {
                this.attachSelectDropdown(row as HTMLElement, prop as PropertySelect);
            }
        }
    }

    // Blender-style click-and-drag scrubbing on a number field: press and hold, then drag
    // sideways to change the value, instead of having to click in and type. A short distance
    // threshold before a drag "arms" keeps a plain click-to-type still working normally -
    // below the threshold nothing here fires and the browser's own focus/click handles it.
    // Values are written straight into the input's DOM value and applied via applyValue
    // without dispatching an 'input' event, so this doesn't re-trigger the existing
    // focus-driven commit/history listeners already wired on the same input - those still
    // bracket the interaction normally since a real focus event still fires on mousedown.
    private attachNumberDrag(
        input: HTMLInputElement,
        getValue: () => number,
        applyValue: (next: number) => void,
        min?: number,
        max?: number,
        step?: number,
    ): void {
        const DRAG_THRESHOLD_PX = 3;
        let dragging = false;
        let startX = 0;
        let startValue = 0;

        const range = (min !== undefined && max !== undefined) ? (max - min) : undefined;
        const sensitivity = range !== undefined ? range / 300 : (step && step > 0 ? step : 1) * 2;

        const onMouseMove = (e: MouseEvent): void => {
            const dx = e.clientX - startX;
            if (!dragging) {
                if (Math.abs(dx) < DRAG_THRESHOLD_PX) return;
                dragging = true;
                input.classList.add('dragging');
                document.body.classList.add('dragging-number-field');
            }
            e.preventDefault();
            let next = startValue + dx * sensitivity;
            if (min !== undefined) next = Math.max(min, next);
            if (max !== undefined) next = Math.min(max, next);
            if (step && step > 0) next = Math.round(next / step) * step;
            next = Number(next.toFixed(6));
            applyValue(next);
        };
        const onMouseUp = (): void => {
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);
            input.classList.remove('dragging');
            document.body.classList.remove('dragging-number-field');
            dragging = false;
        };
        input.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            startX = e.clientX;
            startValue = getValue();
            window.addEventListener('mousemove', onMouseMove);
            window.addEventListener('mouseup', onMouseUp);
        });
    }

    // Fully custom dropdown replacing the native <select> - a browser's own <option> list
    // popup is OS-rendered and can't be restyled from CSS (appearance:none only reaches the
    // closed control), which read as "still default browser" against the rest of the dark
    // themed panel. The option list is appended to document.body (not the row itself) and
    // positioned from the button's own bounding rect, so it isn't clipped by the panel's
    // overflow-y:auto regardless of scroll position.
    private attachSelectDropdown(row: HTMLElement, prop: PropertySelect): void {
        const btn = row.querySelector('.prop-select-btn') as HTMLButtonElement;
        const valueLabel = btn.querySelector('.prop-select-value') as HTMLElement;

        const close = (): void => {
            list.remove();
            document.removeEventListener('mousedown', onOutsideClick, true);
            document.removeEventListener('keydown', onKeyDown, true);
            btn.classList.remove('open');
            if (this.openSelectDropdown?.close === close) this.openSelectDropdown = null;
        };
        const onOutsideClick = (e: MouseEvent): void => {
            if (list.contains(e.target as Node) || btn.contains(e.target as Node)) return;
            close();
        };
        const onKeyDown = (e: KeyboardEvent): void => {
            if (e.key === 'Escape') close();
        };

        const list = document.createElement('div');
        list.className = 'prop-select-options';

        btn.addEventListener('click', () => {
            if (this.openSelectDropdown) {
                const wasThisOne = this.openSelectDropdown.close === close;
                this.openSelectDropdown.close();
                if (wasThisOne) return;
            }

            const currentValue = btn.dataset.value;
            list.innerHTML = '';
            for (const option of prop.options) {
                const item = document.createElement('div');
                item.className = 'prop-select-option' + (option.value === currentValue ? ' selected' : '');
                item.textContent = option.label;
                item.addEventListener('click', () => {
                    const historyLabel = `Edit ${prop.label}`;
                    this.history.beginAction(historyLabel);
                    prop.set(option.value);
                    this.history.endAction(historyLabel);
                    btn.dataset.value = option.value;
                    valueLabel.textContent = option.label;
                    close();
                });
                list.appendChild(item);
            }

            const rect = btn.getBoundingClientRect();
            list.style.left = `${rect.left}px`;
            list.style.top = `${rect.bottom + 2}px`;
            list.style.width = `${rect.width}px`;
            list.style.visibility = 'hidden';
            document.body.appendChild(list);

            // Flip above the button (and clamp horizontally) if the list would otherwise run
            // off the bottom/right of the viewport - the button can sit anywhere in the
            // panel, including right at the bottom edge, and the list is only measurable
            // once it's actually in the document.
            const listRect = list.getBoundingClientRect();
            if (listRect.bottom > window.innerHeight) {
                list.style.top = `${Math.max(4, rect.top - listRect.height - 2)}px`;
            }
            if (listRect.right > window.innerWidth) {
                list.style.left = `${Math.max(4, window.innerWidth - listRect.width - 4)}px`;
            }
            list.style.visibility = 'visible';
            btn.classList.add('open');
            document.addEventListener('mousedown', onOutsideClick, true);
            document.addEventListener('keydown', onKeyDown, true);
            this.openSelectDropdown = { close };
        });
    }

    private beginHistory(row: HTMLElement, label: string): void {
        if (row.dataset.historyPending === 'true') return;
        row.dataset.historyPending = 'true';
        this.history.beginAction(label);
    }

    private endHistory(row: HTMLElement, label: string): void {
        if (row.dataset.historyPending !== 'true') return;
        delete row.dataset.historyPending;
        this.history.endAction(label);
    }

    private refreshValues(): void {
        const def = this.customDef ?? this.element?.getProperties();
        if (!def) return;

        // Only refresh values of inputs not currently focused
        for (const section of def.sections) {
            for (const prop of section.properties) {
                const id = `${section.label}-${prop.label}`.replace(/\s+/g, '-').toLowerCase();
                const row = this.container.querySelector(`[data-prop-id="${id}"]`);
                if (!row) continue;

                if (prop.type === 'vector3') {
                    const v = prop.get();
                    const inputs = row.querySelectorAll('input');
                    if (inputs[0] !== document.activeElement) (inputs[0] as HTMLInputElement).value = v.x.toFixed(3);
                    if (inputs[1] !== document.activeElement) (inputs[1] as HTMLInputElement).value = v.y.toFixed(3);
                    if (inputs[2] !== document.activeElement) (inputs[2] as HTMLInputElement).value = v.z.toFixed(3);
                }

                if (prop.type === 'number') {
                    const input = row.querySelector('input')!;
                    if (input !== document.activeElement) {
                        (input as HTMLInputElement).value = String(prop.get());
                    }
                }

                if (prop.type === 'boolean') {
                    const input = row.querySelector('input')!;
                    if (input !== document.activeElement) {
                        (input as HTMLInputElement).checked = (prop as PropertyBoolean).get();
                    }
                }

                if (prop.type === 'select') {
                    const btn = row.querySelector('.prop-select-btn') as HTMLButtonElement;
                    // Skip while this dropdown is the open one - overwriting mid-interaction
                    // would fight the user's own click.
                    if (this.openSelectDropdown && btn.classList.contains('open')) continue;
                    const selectProp = prop as PropertySelect;
                    const currentValue = selectProp.get();
                    if (btn.dataset.value !== currentValue) {
                        btn.dataset.value = currentValue;
                        const label = selectProp.options.find(o => o.value === currentValue)?.label ?? '';
                        const valueLabel = btn.querySelector('.prop-select-value');
                        if (valueLabel) valueLabel.textContent = label;
                    }
                }
            }
        }
    }

    public dispose(): void {
        if (this.refreshInterval) clearInterval(this.refreshInterval);
    }
}
