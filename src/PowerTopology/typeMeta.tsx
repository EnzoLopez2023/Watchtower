// Selectable item types for the create/edit form + their icons and structural
// behaviour. Devices are all one structural `kind` ('device'); the specific
// category is stored cosmetically in `subtype`. Power sources (strip / UPS /
// outlet) are their own `kind` and expose plugs.

import {
  DevicesOther as GenericDeviceIcon,
  Computer as ComputerIcon,
  Monitor as MonitorIcon,
  Dock as DockIcon,
  Usb as UsbIcon,
  Tv as TvIcon,
  SportsEsports as ConsoleIcon,
  Print as PrinterIcon,
  Scanner as ScannerIcon,
  Storage as DriveIcon,
  Hub as SwitchIcon,
  Router as RouterIcon,
  SettingsInputAntenna as ModemIcon,
  Dvr as NvrIcon,
  Power as StripIcon,
  BatteryChargingFull as UpsIcon,
  Outlet as OutletIcon,
} from '@mui/icons-material';
import type { SvgIconComponent } from '@mui/icons-material';
import type { ItemKind, PowerItem } from './types';

export type TypeGroup = 'Devices' | 'Power sources';

export interface TypeOption {
  /** Select value; also the stored `subtype` for device categories. */
  value: string;
  kind: ItemKind;
  subtype: string | null;
  label: string;
  group: TypeGroup;
  providesPlugs: boolean;
  acceptsPower: boolean;
  defaultPlugs: number;
  Icon: SvgIconComponent;
}

const device = (value: string, subtype: string | null, label: string, Icon: SvgIconComponent): TypeOption => ({
  value,
  kind: 'device',
  subtype,
  label,
  group: 'Devices',
  providesPlugs: false,
  acceptsPower: true,
  defaultPlugs: 0,
  Icon,
});

// Named so the lookups below can fall back to it without asserting that the
// option list is non-empty.
const GENERIC_DEVICE_OPTION = device('device', null, 'Device', GenericDeviceIcon);

export const TYPE_OPTIONS: TypeOption[] = [
  GENERIC_DEVICE_OPTION,
  device('computer', 'computer', 'Computer', ComputerIcon),
  device('monitor', 'monitor', 'Monitor', MonitorIcon),
  device('laptop_dock', 'laptop_dock', 'Laptop Dock', DockIcon),
  device('usb_charging_station', 'usb_charging_station', 'USB Charging Station', UsbIcon),
  device('tv', 'tv', 'TV', TvIcon),
  device('game_console', 'game_console', 'Game Console', ConsoleIcon),
  device('printer', 'printer', 'Printer', PrinterIcon),
  device('scanner', 'scanner', 'Scanner', ScannerIcon),
  device('external_hdd', 'external_hdd', 'External Hard Drive', DriveIcon),
  device('network_switch', 'network_switch', 'Network Switch', SwitchIcon),
  device('network_router', 'network_router', 'Network Router / Gateway', RouterIcon),
  device('isp_modem', 'isp_modem', 'ISP Modem', ModemIcon),
  device('nvr', 'nvr', 'NVR', NvrIcon),
  {
    value: 'power_strip',
    kind: 'power_strip',
    subtype: null,
    label: 'Power Strip',
    group: 'Power sources',
    providesPlugs: true,
    acceptsPower: true,
    defaultPlugs: 6,
    Icon: StripIcon,
  },
  {
    value: 'ups',
    kind: 'ups',
    subtype: null,
    label: 'UPS',
    group: 'Power sources',
    providesPlugs: true,
    acceptsPower: true,
    defaultPlugs: 8,
    Icon: UpsIcon,
  },
  {
    value: 'outlet',
    kind: 'outlet',
    subtype: null,
    label: 'Wall Outlet',
    group: 'Power sources',
    providesPlugs: true,
    acceptsPower: false,
    defaultPlugs: 2,
    Icon: OutletIcon,
  },
];

const GENERIC_DEVICE: TypeOption = GENERIC_DEVICE_OPTION;

export function optionByValue(value: string): TypeOption {
  return TYPE_OPTIONS.find((o) => o.value === value) ?? GENERIC_DEVICE;
}

/** Resolve the display option (icon + label) for a stored item. */
export function optionForItem(item: PowerItem): TypeOption {
  if (item.kind === 'device') {
    return (
      TYPE_OPTIONS.find((o) => o.kind === 'device' && o.subtype === (item.subtype ?? null)) ??
      GENERIC_DEVICE
    );
  }
  return TYPE_OPTIONS.find((o) => o.value === item.kind) ?? GENERIC_DEVICE;
}
