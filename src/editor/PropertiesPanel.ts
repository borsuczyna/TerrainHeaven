import * as THREE from 'three';
import { singleton, inject } from 'tsyringe';
import type { PropertyDefinition, PropertyVector3, PropertyNumber, PropertyBoolean, PropertySelect, PropertyButton, SectionItem } from './Properties';
import type WorldElement from '../elements/WorldElement';
import CopyManager from './CopyManager';
import HistoryManager from './HistoryManager';
import { createIcons, icons } from 'lucide';
import PresetManager from './PresetManager';
import PresetPanel from './panels/PresetPanel';

@singleton()
export default class PropertiesPanel {
    private container: HTMLElement;
    private element: WorldElement | null = null;
    private refreshInterval: number | null = null;
    private customDef: PropertyDefinition | null = null;
    private readonly copyManager: CopyManager;
    private readonly history: HistoryManager;

    constructor(
        @inject(CopyManager) copyManager: CopyManager,
        @inject(HistoryManager) history: HistoryManager,
        @inject(PresetManager) private readonly presets: PresetManager,
        @inject(PresetPanel) private readonly presetPanel: PresetPanel,
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
                            <input type="number" step="0.1" value="${v.x.toFixed(3)}" data-axis="x">
                        </div>
                        <div class="prop-field">
                            <span class="axis-label y">Y</span>
                            <input type="number" step="0.1" value="${v.y.toFixed(3)}" data-axis="y">
                        </div>
                        <div class="prop-field">
                            <span class="axis-label z">Z</span>
                            <input type="number" step="0.1" value="${v.z.toFixed(3)}" data-axis="z">
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
                            <input type="number" step="${step}" ${min} ${max} value="${v}">
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
            const optionsHtml = prop.options.map(o =>
                `<option value="${o.value}"${o.value === v ? ' selected' : ''}>${o.label}</option>`
            ).join('');
            return `
                <div class="prop-row" data-prop-id="${id}" data-prop-type="select">
                    <span class="prop-label">${prop.label}</span>
                    <div class="prop-fields">
                        <div class="prop-field-single">
                            <select>${optionsHtml}</select>
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
        this.presetPanel.show();
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
                inputs.forEach(input => {
                    input.addEventListener('focus', () => this.beginHistory(row as HTMLElement, historyLabel));
                    input.addEventListener('change', commit);
                    input.addEventListener('change', () => this.endHistory(row as HTMLElement, historyLabel));
                    input.addEventListener('blur', () => this.endHistory(row as HTMLElement, historyLabel));
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
                const select = row.querySelector('select')!;
                select.addEventListener('change', () => {
                    const historyLabel = `Edit ${prop.label}`;
                    this.history.beginAction(historyLabel);
                    (prop as PropertySelect).set(select.value);
                    this.history.endAction(historyLabel);
                });
            }
        }
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
                    const select = row.querySelector('select')!;
                    if (select !== document.activeElement) {
                        (select as HTMLSelectElement).value = (prop as PropertySelect).get();
                    }
                }
            }
        }
    }

    public dispose(): void {
        if (this.refreshInterval) clearInterval(this.refreshInterval);
    }
}
