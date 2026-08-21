import { inject, singleton } from 'tsyringe';
import type WorldElement from '../elements/WorldElement';
import type { UVTransform } from '../elements/WorldElement';
import TextureLibrary from './TextureLibrary';

export type PresetValue = number | boolean | string;

export interface ElementPreset {
    id: string;
    name: string;
    elementType: string;
    elementTitle: string;
    properties: Record<string, PresetValue>;
    textures: Record<string, string>;
    textureRotations: Record<string, number>;
    uvTransforms: Record<string, UVTransform>;
    createdAt: number;
}

interface PresetStore {
    version: 1;
    presets: ElementPreset[];
    defaults: Record<string, string>;
}

const STORAGE_KEY = 'terrainheaven-element-presets-v1';

@singleton()
export default class PresetManager {
    private store: PresetStore = { version: 1, presets: [], defaults: {} };
    public onChanged: (() => void) | null = null;

    constructor(@inject(TextureLibrary) private readonly textures: TextureLibrary) {
        this.load();
    }

    public getPresets(): ElementPreset[] {
        return [...this.store.presets].sort((a, b) => b.createdAt - a.createdAt);
    }

    public getPreset(id: string): ElementPreset | null {
        return this.store.presets.find((preset) => preset.id === id) ?? null;
    }

    public isDefault(preset: ElementPreset): boolean {
        return this.store.defaults[preset.elementType] === preset.id;
    }

    public savePreset(name: string, element: WorldElement): ElementPreset {
        const definition = element.getProperties();
        const properties: Record<string, PresetValue> = {};
        for (const section of definition.sections) {
            for (const property of section.properties) {
                if (property.type === 'button' || property.type === 'vector3') continue;
                properties[this.propertyKey(section.label, property.label)] = property.get();
            }
        }

        const texturePaths = Object.fromEntries(element.getGroupTextureReferences());
        const textureRotations = Object.fromEntries(element.textureRotations);
        const uvTransforms = Object.fromEntries(element.getUVGroups().map((group) => [group, element.getUVTransform(group)]));
        const preset: ElementPreset = {
            id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`,
            name: name.trim() || `${definition.title} Preset`,
            elementType: element.constructor.name,
            elementTitle: definition.title,
            properties,
            textures: texturePaths,
            textureRotations,
            uvTransforms,
            createdAt: Date.now(),
        };
        this.store.presets.push(preset);
        this.persist();
        return preset;
    }

    public deletePreset(id: string): void {
        const preset = this.getPreset(id);
        if (!preset) return;
        this.store.presets = this.store.presets.filter((candidate) => candidate.id !== id);
        if (this.store.defaults[preset.elementType] === id) delete this.store.defaults[preset.elementType];
        this.persist();
    }

    public setDefault(id: string): void {
        const preset = this.getPreset(id);
        if (!preset) return;
        if (this.store.defaults[preset.elementType] === id) delete this.store.defaults[preset.elementType];
        else this.store.defaults[preset.elementType] = id;
        this.persist();
    }

    public applyDefault(element: WorldElement): boolean {
        const id = this.store.defaults[element.constructor.name];
        return id ? this.applyPreset(id, element) : false;
    }

    public applyPreset(id: string, element: WorldElement): boolean {
        const preset = this.getPreset(id);
        if (!preset || preset.elementType !== element.constructor.name) return false;

        // Several inspectors expose conditional fields (e.g. box thickness only after
        // Style becomes Box). Re-read the definition across a few passes so applying
        // discriminator values reveals and then applies their dependent properties.
        const pending = new Map(Object.entries(preset.properties));
        for (let pass = 0; pass < 4 && pending.size > 0; pass++) {
            const definition = element.getProperties();
            for (const section of definition.sections) {
                for (const property of section.properties) {
                    if (property.type === 'button' || property.type === 'vector3') continue;
                    const key = this.propertyKey(section.label, property.label);
                    if (!pending.has(key)) continue;
                    const value = pending.get(key)!;
                    if (property.type === 'number' && typeof value === 'number') property.set(value);
                    else if (property.type === 'boolean' && typeof value === 'boolean') property.set(value);
                    else if (property.type === 'select' && typeof value === 'string') property.set(value);
                    pending.delete(key);
                }
            }
        }

        for (const [group, rotation] of Object.entries(preset.textureRotations)) {
            element.setTextureRotation(group, rotation);
        }
        for (const [group, transform] of Object.entries(preset.uvTransforms)) {
            element.setUVTransform(group, transform);
        }
        for (const [group, path] of Object.entries(preset.textures)) {
            element.setGroupTextureReference(group, path);
            void this.textures.loadTexture(path).then((texture) => {
                if (texture) element.setGroupTexture(group, texture, path);
            });
        }
        element.update();
        element.onPropertiesChanged?.();
        return true;
    }

    private propertyKey(section: string, property: string): string {
        return `${section}\u0000${property}`;
    }

    private load(): void {
        if (typeof localStorage === 'undefined') return;
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return;
            const parsed = JSON.parse(raw) as Partial<PresetStore>;
            if (parsed.version !== 1 || !Array.isArray(parsed.presets)) return;
            this.store = {
                version: 1,
                presets: parsed.presets,
                defaults: parsed.defaults && typeof parsed.defaults === 'object' ? parsed.defaults : {},
            };
        } catch (error) {
            console.warn('Could not load element presets:', error);
        }
    }

    private persist(): void {
        if (typeof localStorage === 'undefined') {
            this.onChanged?.();
            return;
        }
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(this.store));
        } catch (error) {
            console.warn('Could not save element presets:', error);
        }
        this.onChanged?.();
    }
}
