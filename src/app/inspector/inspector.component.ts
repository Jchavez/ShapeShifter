import { Component, OnInit, PipeTransform, Pipe, ChangeDetectionStrategy } from '@angular/core';
import { Command } from '../scripts/commands';
import { CanvasType } from '../CanvasType';
import { LayerStateService } from '../services';
import { Observable } from 'rxjs/Observable';
import 'rxjs/add/observable/combineLatest';

@Component({
  selector: 'app-inspector',
  templateUrl: './inspector.component.html',
  styleUrls: ['./inspector.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InspectorComponent implements OnInit {
  START_CANVAS = CanvasType.Start;
  END_CANVAS = CanvasType.End;
  subPathItemsObservable: Observable<[string, string]>;

  constructor(private layerStateService: LayerStateService) { }

  ngOnInit() {
    this.subPathItemsObservable = Observable.combineLatest(
      this.layerStateService.getActivePathIdObservable(CanvasType.Start),
      this.layerStateService.getActivePathIdObservable(CanvasType.End));
  }

  trackSubPath(index: number, item: SubPathItem) {
    return item.subPathItemId;
  }

  trackCommand(index: number, item: Command) {
    return item.getId();
  }
}

// TODO: save the previous expanded state somehow?
class SubPathItem {
  constructor(
    public readonly subIdx: number,
    public readonly subPathItemId: string,
    public readonly startCmdItems: Command[] = [],
    public readonly endCmdItems: Command[] = [],
    public isExpanded = true) { }
}

@Pipe({ name: 'toSubPathItems' })
export class SubPathItemsPipe implements PipeTransform {
  constructor(private layerStateService: LayerStateService) { }

  transform(activePathIds: [string, string]): SubPathItem[] {
    const subPathItems: SubPathItem[] = [];

    const getPathFn = (canvasType: CanvasType) => {
      const pathLayer = this.layerStateService.getActivePathLayer(canvasType);
      if (!pathLayer) {
        return undefined;
      }
      return pathLayer.pathData;
    };

    const startPathCmd = getPathFn(CanvasType.Start);
    const endPathCmd = getPathFn(CanvasType.End);
    const numStartSubPaths = startPathCmd ? startPathCmd.getSubPaths().length : 0;
    const numEndSubPaths = endPathCmd ? endPathCmd.getSubPaths().length : 0;
    const maxPath = numStartSubPaths < numEndSubPaths ? endPathCmd : startPathCmd;
    const idsToUse = maxPath ? maxPath.getSubPaths().map(s => s.getId()) : [];
    for (let i = 0; i < Math.max(numStartSubPaths, numEndSubPaths); i++) {
      const startCmdItems: Command[] = [];
      const endCmdItems: Command[] = [];
      if (i < numStartSubPaths) {
        startCmdItems.push(...startPathCmd.getSubPaths()[i].getCommands());
      }
      if (i < numEndSubPaths) {
        endCmdItems.push(...endPathCmd.getSubPaths()[i].getCommands());
      }
      subPathItems.push(new SubPathItem(i, idsToUse[i], startCmdItems, endCmdItems));
    }
    return subPathItems;
  }
}
