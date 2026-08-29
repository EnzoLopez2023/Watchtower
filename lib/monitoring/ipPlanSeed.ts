export interface IpPlanSeedRow {
  readonly mac: string;
  readonly name: string;
  readonly group_code: string;
  readonly group_label: string;
  readonly group_order: number;
  readonly original_ip: string | null;
  readonly target_ip: string | null;
  readonly sort_order: number;
  readonly already_reserved: boolean;
}

export interface IpPlanBlock {
  readonly code: string;
  readonly label: string;
  readonly order: number;
  readonly subnet: string;
  readonly lo: number;
  readonly hi: number;
}

export const IP_PLAN_SEED: readonly IpPlanSeedRow[] = [
  { mac: "e4:38:83:2e:d0:51", name: "Dream Machine Pro", group_code: "GW", group_label: "Gateway", group_order: 10, original_ip: "192.168.1.1", target_ip: "192.168.1.1", sort_order: 0, already_reserved: false },
  { mac: "ac:8b:a9:6b:63:0c", name: "ac8ba96b630c0728ed3f077f6efc063aba16b.id.ui.direct", group_code: "INF", group_label: "Core infrastructure", group_order: 20, original_ip: "192.168.1.2", target_ip: "192.168.1.2", sort_order: 1, already_reserved: false },
  { mac: "1c:0b:8b:3a:fa:b9", name: "UPS 2U", group_code: "INF", group_label: "Core infrastructure", group_order: 20, original_ip: "192.168.1.236", target_ip: "192.168.1.3", sort_order: 2, already_reserved: false },
  { mac: "90:41:b2:9c:f3:c3", name: "UPS Tower", group_code: "INF", group_label: "Core infrastructure", group_order: 20, original_ip: "192.168.1.164", target_ip: "192.168.1.4", sort_order: 3, already_reserved: false },
  { mac: "b4:fb:e4:e0:d5:20", name: "Coop Switch", group_code: "NET", group_label: "Network gear", group_order: 30, original_ip: "192.168.1.157", target_ip: "192.168.1.20", sort_order: 4, already_reserved: false },
  { mac: "e0:63:da:54:02:9e", name: "E-Shack", group_code: "NET", group_label: "Network gear", group_order: 30, original_ip: "192.168.1.225", target_ip: "192.168.1.21", sort_order: 5, already_reserved: false },
  { mac: "78:8a:20:fa:79:08", name: "House Switch", group_code: "NET", group_label: "Network gear", group_order: 30, original_ip: "192.168.1.112", target_ip: "192.168.1.22", sort_order: 6, already_reserved: false },
  { mac: "1c:6a:1b:53:36:65", name: "Office Switch", group_code: "NET", group_label: "Network gear", group_order: 30, original_ip: "192.168.1.144", target_ip: "192.168.1.23", sort_order: 7, already_reserved: false },
  { mac: "e0:63:da:54:33:04", name: "Patio Switch", group_code: "NET", group_label: "Network gear", group_order: 30, original_ip: "192.168.1.173", target_ip: "192.168.1.24", sort_order: 8, already_reserved: false },
  { mac: "74:f9:2c:b2:92:b5", name: "U5G Backup", group_code: "NET", group_label: "Network gear", group_order: 30, original_ip: "192.168.1.155", target_ip: "192.168.1.25", sort_order: 9, already_reserved: false },
  { mac: "e4:38:83:2b:32:f1", name: "U6 Pro", group_code: "NET", group_label: "Network gear", group_order: 30, original_ip: "192.168.1.241", target_ip: "192.168.1.26", sort_order: 10, already_reserved: false },
  { mac: "a8:9c:6c:74:79:d8", name: "U7 Pro", group_code: "NET", group_label: "Network gear", group_order: 30, original_ip: "192.168.1.70", target_ip: "192.168.1.27", sort_order: 11, already_reserved: false },
  { mac: "18:e8:29:50:0d:09", name: "UniFi AP Mesh - Coop", group_code: "NET", group_label: "Network gear", group_order: 30, original_ip: "192.168.1.175", target_ip: "192.168.1.28", sort_order: 12, already_reserved: false },
  { mac: "18:e8:29:50:0c:ae", name: "UniFi AP Mesh - Shop", group_code: "NET", group_label: "Network gear", group_order: 30, original_ip: "192.168.1.65", target_ip: "192.168.1.29", sort_order: 13, already_reserved: false },
  { mac: "d8:b3:70:5f:88:52", name: "UniFi AP-AC-In Wall - U6-IW", group_code: "NET", group_label: "Network gear", group_order: 30, original_ip: "192.168.1.73", target_ip: "192.168.1.30", sort_order: 14, already_reserved: false },
  { mac: "fc:ec:da:a3:3a:2b", name: "UniFi AP-AC-Pro - 2nd Floor", group_code: "NET", group_label: "Network gear", group_order: 30, original_ip: "192.168.1.97", target_ip: "192.168.1.31", sort_order: 15, already_reserved: false },
];

export const IP_PLAN_BLOCKS: readonly IpPlanBlock[] = [
  { code: "GW",  label: "Gateway",              order: 10, subnet: "192.168.1", lo: 1,   hi: 1   },
  { code: "INF", label: "Core infrastructure",  order: 20, subnet: "192.168.1", lo: 2,   hi: 19  },
  { code: "NET", label: "Network gear",          order: 30, subnet: "192.168.1", lo: 20,  hi: 49  },
  { code: "SRV", label: "Servers & NAS",         order: 40, subnet: "192.168.1", lo: 50,  hi: 69  },
  { code: "CAM", label: "Cameras",               order: 50, subnet: "192.168.1", lo: 70,  hi: 109 },
  { code: "MED", label: "Media & AV",            order: 60, subnet: "192.168.1", lo: 110, hi: 124 },
  { code: "VOX", label: "Voice assistants",      order: 70, subnet: "192.168.1", lo: 125, hi: 134 },
  { code: "IOT", label: "Smart home & IoT",      order: 80, subnet: "192.168.1", lo: 135, hi: 169 },
  { code: "PRN", label: "Printers & misc",       order: 90, subnet: "192.168.1", lo: 170, hi: 175 },
  { code: "DYN", label: "DHCP pool (roaming)",   order: 99, subnet: "192.168.1", lo: 176, hi: 250 },
];
