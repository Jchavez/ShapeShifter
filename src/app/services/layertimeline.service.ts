import 'rxjs/add/operator/first';
import 'rxjs/add/observable/combineLatest';

import { Injectable } from '@angular/core';
import { Action } from '@ngrx/store';
import { INTERPOLATORS } from 'app/model/interpolators';
import { GroupLayer, Layer, LayerUtil, VectorLayer } from 'app/model/layers';
import { Animation, AnimationBlock } from 'app/model/timeline';
import { ModelUtil } from 'app/scripts/common';
import { State, Store } from 'app/store';
import {
  SetCollapsedLayers,
  SetHiddenLayers,
  SetSelectedLayers,
  SetVectorLayer,
} from 'app/store/layers/actions';
import {
  getCollapsedLayerIds,
  getHiddenLayerIds,
  getSelectedLayerIds,
  getVectorLayer,
} from 'app/store/layers/selectors';
import { MultiAction } from 'app/store/multiaction/actions';
import { SelectAnimation, SetAnimation, SetSelectedBlocks } from 'app/store/timeline/actions';
import {
  getAnimation,
  getSelectedBlockIds,
  isAnimationSelected,
} from 'app/store/timeline/selectors';
import * as _ from 'lodash';
import { OutputSelector } from 'reselect';

/**
 * A simple service that provides an interface for making layer/timeline changes.
*/
@Injectable()
export class LayerTimelineService {
  constructor(private readonly store: Store<State>) {}

  /**
   * Selects or deselects the animation.
   */
  selectAnimation(isSelected: boolean) {
    this.updateSelections(isSelected, new Set(), new Set());
  }

  /**
   * Selects or deselects the specified block ID.
   */
  selectBlock(blockId: string, clearExisting: boolean) {
    const selectedBlockIds = this.getSelectedBlockIds();
    if (clearExisting) {
      selectedBlockIds.forEach(id => {
        if (id !== blockId) {
          selectedBlockIds.delete(id);
        }
      });
    }
    if (!clearExisting && selectedBlockIds.has(blockId)) {
      selectedBlockIds.delete(blockId);
    } else {
      selectedBlockIds.add(blockId);
    }
    this.updateSelections(false, selectedBlockIds, new Set());
  }

  /**
   * Selects or deselects the specified layer ID.
   */
  selectLayer(layerId: string, clearExisting: boolean) {
    const selectedLayerIds = this.getSelectedLayerIds();
    if (clearExisting) {
      selectedLayerIds.forEach(id => {
        if (id !== layerId) {
          selectedLayerIds.delete(id);
        }
      });
    }
    if (!clearExisting && selectedLayerIds.has(layerId)) {
      selectedLayerIds.delete(layerId);
    } else {
      selectedLayerIds.add(layerId);
    }
    this.updateSelections(false, new Set(), selectedLayerIds);
  }

  /**
   * Clears all animation/block/layer selections.
   */
  clearSelections() {
    this.updateSelections(false, new Set(), new Set());
  }

  private updateSelections(
    isAnimSelected: boolean,
    selectedBlockIds: Set<string>,
    selectedLayerIds: Set<string>,
  ) {
    const actions: Action[] = [];
    if (this.isAnimationSelected() !== isAnimSelected) {
      actions.push(new SelectAnimation(isAnimSelected));
    }
    if (!_.isEqual(this.getSelectedBlockIds(), selectedBlockIds)) {
      actions.push(new SetSelectedBlocks(selectedBlockIds));
    }
    if (!_.isEqual(this.getSelectedLayerIds(), selectedLayerIds)) {
      actions.push(new SetSelectedLayers(selectedLayerIds));
    }
    if (actions.length) {
      this.store.dispatch(new MultiAction(...actions));
    }
  }

  /**
   * Toggles the specified layer's expanded state.
   */
  toggleExpandedLayer(layerId: string, recursive: boolean) {
    const layerIds = new Set([layerId]);
    if (recursive) {
      const layer = this.getVectorLayer().findLayerById(layerId);
      if (layer) {
        layer.walk(l => layerIds.add(l.id));
      }
    }
    const collapsedLayerIds = this.getCollapsedLayerIds();
    if (collapsedLayerIds.has(layerId)) {
      layerIds.forEach(id => collapsedLayerIds.delete(id));
    } else {
      layerIds.forEach(id => collapsedLayerIds.add(id));
    }
    this.store.dispatch(new SetCollapsedLayers(collapsedLayerIds));
  }

  /**
   * Toggles the specified layer's visibility.
   */
  toggleVisibleLayer(layerId: string) {
    const layerIds = this.getHiddenLayerIds();
    if (layerIds.has(layerId)) {
      layerIds.delete(layerId);
    } else {
      layerIds.add(layerId);
    }
    this.store.dispatch(new SetHiddenLayers(layerIds));
  }

  /**
   * Imports a list of vector layers into the workspace.
   */
  importLayers(vls: ReadonlyArray<VectorLayer>) {
    if (!vls.length) {
      return;
    }
    const importedVls = [...vls];
    const vectorLayer = this.getVectorLayer();
    let vectorLayers = [vectorLayer];
    if (!vectorLayer.children.length) {
      // Simply replace the empty vector layer rather than merging with it.
      const vl = importedVls[0].clone();
      vl.name = vectorLayer.name;
      importedVls[0] = vl;
      vectorLayers = [];
    }
    const newVectorLayers = [...vectorLayers, ...importedVls];
    const newVl =
      newVectorLayers.length === 1
        ? newVectorLayers[0]
        : newVectorLayers.reduce(LayerUtil.mergeVectorLayers);
    this.setVectorLayer(newVl);
  }

  /**
   * Adds a layer to the vector tree.
   */
  addLayer(layer: Layer) {
    const vl = this.getVectorLayer();
    const selectedLayers = this.getSelectedLayers();
    if (selectedLayers.length === 1) {
      const selectedLayer = selectedLayers[0];
      if (!(selectedLayer instanceof VectorLayer)) {
        // Add the new layer as a sibling to the currently selected layer.
        const parent = LayerUtil.findParent(vl, selectedLayer.id).clone();
        const children = [...parent.children];
        parent.children = children.concat([layer]);
        this.replaceLayer(parent);
        return;
      }
    }
    const vectorLayer = vl.clone();
    vectorLayer.children = [...vectorLayer.children, layer];
    this.replaceLayer(vectorLayer);
  }

  setVectorLayer(vl: VectorLayer) {
    this.store.dispatch(new SetVectorLayer(vl));
  }

  replaceLayer(layer: Layer) {
    this.setVectorLayer(LayerUtil.replaceLayerInTree(this.getVectorLayer(), layer));
  }

  groupOrUngroupSelectedLayers(shouldGroup: boolean) {
    let selectedLayerIds = this.getSelectedLayerIds();
    if (!selectedLayerIds.size) {
      return;
    }
    let vectorLayer = this.getVectorLayer();

    // Sort selected layers by order they appear in tree.
    let tempSelLayers = Array.from(selectedLayerIds).map(id => vectorLayer.findLayerById(id));
    const selLayerOrdersMap = new Map<string, number>();
    let n = 0;
    vectorLayer.walk(layer => {
      if (_.find(tempSelLayers, l => l.id === layer.id)) {
        selLayerOrdersMap.set(layer.id, n);
        n++;
      }
    });
    tempSelLayers.sort((a, b) => selLayerOrdersMap.get(a.id) - selLayerOrdersMap.get(b.id));

    if (shouldGroup) {
      // Remove any layers that are descendants of other selected layers,
      // and remove the vectorLayer itself if selected.
      tempSelLayers = tempSelLayers.filter(layer => {
        if (layer instanceof VectorLayer) {
          return false;
        }
        let p = LayerUtil.findParent(vectorLayer, layer.id);
        while (p) {
          if (_.find(tempSelLayers, l => l.id === p.id)) {
            return false;
          }
          p = LayerUtil.findParent(vectorLayer, p.id);
        }
        return true;
      });

      if (!tempSelLayers.length) {
        return;
      }

      // Find destination parent and insertion point.
      const firstSelectedLayerParent = LayerUtil.findParent(
        vectorLayer,
        tempSelLayers[0].id,
      ).clone();
      const firstSelectedLayerIndexInParent = _.findIndex(
        firstSelectedLayerParent.children,
        l => l.id === tempSelLayers[0].id,
      );

      // Remove all selected items from their parents and move them into a new parent.
      const newGroup = new GroupLayer({
        name: LayerUtil.getUniqueLayerName([vectorLayer], 'group'),
        children: tempSelLayers,
      });
      const parentChildren = [...firstSelectedLayerParent.children];
      parentChildren.splice(firstSelectedLayerIndexInParent, 0, newGroup);
      _.remove(parentChildren, child =>
        _.find(tempSelLayers, selectedLayer => selectedLayer.id === child.id),
      );
      firstSelectedLayerParent.children = parentChildren;
      vectorLayer = LayerUtil.replaceLayerInTree(vectorLayer, firstSelectedLayerParent);
      selectedLayerIds = new Set([newGroup.id]);
    } else {
      // Ungroup selected groups layers.
      const newSelectedLayers: Layer[] = [];
      tempSelLayers.filter(layer => layer instanceof GroupLayer).forEach(groupLayer => {
        // Move children into parent.
        const parent = LayerUtil.findParent(vectorLayer, groupLayer.id).clone();
        const indexInParent = Math.max(
          0,
          _.findIndex(parent.children, l => l.id === groupLayer.id),
        );
        const newChildren = [...parent.children];
        newChildren.splice(indexInParent, 0, ...groupLayer.children);
        parent.children = newChildren;
        vectorLayer = LayerUtil.replaceLayerInTree(vectorLayer, parent);
        newSelectedLayers.splice(0, 0, ...groupLayer.children);
        // Delete the parent.
        vectorLayer = LayerUtil.removeLayersFromTree(vectorLayer, groupLayer.id);
      });
      selectedLayerIds = new Set(newSelectedLayers.map(l => l.id));
    }
    this.store.dispatch(
      new MultiAction(new SetVectorLayer(vectorLayer), new SetSelectedLayers(selectedLayerIds)),
    );
  }

  deleteSelectedModels() {
    const collapsedLayerIds = this.getCollapsedLayerIds();
    const hiddenLayerIds = this.getHiddenLayerIds();
    const selectedLayerIds = this.getSelectedLayerIds();

    let vl = this.getVectorLayer();
    if (selectedLayerIds.has(vl.id)) {
      vl = new VectorLayer();
      collapsedLayerIds.clear();
      hiddenLayerIds.clear();
    } else {
      selectedLayerIds.forEach(layerId => {
        vl = LayerUtil.removeLayersFromTree(vl, layerId);
        collapsedLayerIds.delete(layerId);
        hiddenLayerIds.delete(layerId);
      });
    }

    let animation = this.getAnimation();
    if (this.isAnimationSelected()) {
      animation = new Animation();
    }

    const selectedBlockIds = this.getSelectedBlockIds();
    if (selectedBlockIds.size) {
      animation = animation.clone();
      animation.blocks = animation.blocks.filter(b => !selectedBlockIds.has(b.id));
    }

    // Remove any blocks corresponding to deleted layers.
    const filteredBlocks = animation.blocks.filter(b => !!vl.findLayerById(b.layerId));
    if (filteredBlocks.length !== animation.blocks.length) {
      animation = animation.clone();
      animation.blocks = filteredBlocks;
    }

    this.store.dispatch(
      new MultiAction(
        new SetVectorLayer(vl),
        new SetCollapsedLayers(collapsedLayerIds),
        new SetHiddenLayers(hiddenLayerIds),
        new SetSelectedLayers(new Set()),
        new SelectAnimation(false),
        new SetAnimation(animation),
        new SetSelectedBlocks(new Set()),
      ),
    );
  }

  replaceBlocks(blocks: ReadonlyArray<AnimationBlock>) {
    if (!blocks.length) {
      return;
    }
    const animation = this.getAnimation().clone();
    animation.blocks = animation.blocks.map(block => {
      const newBlock = _.find(blocks, b => block.id === b.id);
      return newBlock ? newBlock : block;
    });
    this.store.dispatch(new SetAnimation(animation));
  }

  addBlocks(
    blocks: Array<{
      id?: string;
      layerId: string;
      propertyName: string;
      fromValue: any;
      toValue: any;
      currentTime: number;
      duration?: number;
      interpolator?: string;
    }>,
    autoSelectBlocks = true,
  ) {
    blocks.forEach(b => {
      if (!b.id) {
        b.id = _.uniqueId();
      }
    });
    let animation = this.getAnimation();
    for (const block of blocks) {
      animation = this.addBlockToAnimation(animation, block);
    }
    this.store.dispatch(
      new MultiAction(
        new SetAnimation(animation),
        new SelectAnimation(false),
        new SetSelectedBlocks(new Set(blocks.map(b => b.id))),
        new SetSelectedLayers(new Set()),
      ),
    );
  }

  private addBlockToAnimation(
    animation: Animation,
    block: {
      id?: string;
      layerId: string;
      propertyName: string;
      fromValue: any;
      toValue: any;
      currentTime: number;
      duration?: number;
      interpolator?: string;
    },
  ) {
    const layer = this.getVectorLayer().findLayerById(block.layerId);
    if (!layer) {
      return animation;
    }
    const newBlockDuration = block.duration || 100;
    const interpolator = block.interpolator || INTERPOLATORS[0].value;
    const propertyName = block.propertyName;
    const currentTime = block.currentTime;

    // Find the right start time for the block, which should be a gap between
    // neighboring blocks closest to the active time cursor, of a minimum size.
    const blocksByLayerId = ModelUtil.getOrderedBlocksByPropertyByLayer(animation);
    const blockNeighbors = (blocksByLayerId[layer.id] || {})[propertyName] || [];
    let gaps: Array<{ start: number; end: number }> = [];
    for (let i = 0; i < blockNeighbors.length; i++) {
      gaps.push({
        start: i === 0 ? 0 : blockNeighbors[i - 1].endTime,
        end: blockNeighbors[i].startTime,
      });
    }
    gaps.push({
      start: blockNeighbors.length ? blockNeighbors[blockNeighbors.length - 1].endTime : 0,
      end: animation.duration,
    });
    gaps = gaps
      .filter(gap => gap.end - gap.start > newBlockDuration)
      .map(gap => {
        const dist = Math.min(Math.abs(gap.end - currentTime), Math.abs(gap.start - currentTime));
        return { ...gap, dist };
      })
      .sort((a, b) => a.dist - b.dist);

    if (!gaps.length) {
      // No available gaps, cancel.
      // TODO: show a disabled button to prevent this case?
      console.warn('Ignoring failed attempt to add animation block');
      return animation;
    }

    let startTime = Math.max(currentTime, gaps[0].start);
    const endTime = Math.min(startTime + newBlockDuration, gaps[0].end);
    if (endTime - startTime < newBlockDuration) {
      startTime = endTime - newBlockDuration;
    }

    // Generate the new block.
    const property = layer.animatableProperties.get(propertyName);
    let type: 'path' | 'color' | 'number';
    if (property.getTypeName() === 'PathProperty') {
      type = 'path';
    } else if (property.getTypeName() === 'ColorProperty') {
      type = 'color';
    } else {
      type = 'number';
    }

    // TODO: clone the current rendered property value and set the from/to values appropriately
    // const valueAtCurrentTime =
    //   this.studioState_.animationRenderer
    //     .getLayerPropertyValue(layer.id, propertyName);

    const newBlock = AnimationBlock.from({
      id: block.id ? block.id : undefined,
      layerId: layer.id,
      propertyName,
      startTime,
      endTime,
      fromValue: block.fromValue,
      toValue: block.toValue,
      interpolator,
      type,
    });
    animation = animation.clone();
    animation.blocks = [...animation.blocks, newBlock];
    return animation;
  }

  getVectorLayer() {
    return this.queryStore(getVectorLayer);
  }

  private getSelectedLayerIds() {
    return new Set(this.queryStore(getSelectedLayerIds));
  }

  getSelectedLayers() {
    const vl = this.getVectorLayer();
    return Array.from(this.getSelectedLayerIds()).map(id => vl.findLayerById(id));
  }

  private getHiddenLayerIds() {
    return new Set(this.queryStore(getHiddenLayerIds));
  }

  private getCollapsedLayerIds() {
    return new Set(this.queryStore(getCollapsedLayerIds));
  }

  private getSelectedBlockIds() {
    return new Set(this.queryStore(getSelectedBlockIds));
  }

  getSelectedBlocks() {
    const anim = this.getAnimation();
    const blockIds = this.getSelectedBlockIds();
    return Array.from(blockIds).map(id => _.find(anim.blocks, b => b.id === id));
  }

  getAnimation() {
    return this.queryStore(getAnimation);
  }

  isAnimationSelected() {
    return this.queryStore(isAnimationSelected);
  }

  private queryStore<T>(selector: OutputSelector<Object, T, (res: Object) => T>) {
    let obj: T;
    this.store.select(selector).first().subscribe(o => (obj = o));
    return obj;
  }
}
