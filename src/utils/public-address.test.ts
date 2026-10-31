import { expect, test } from "bun:test";
import { isPublicAddress } from "./public-address";

// The pane screenshot's HTTP bridge fetches from the user's machine; an address it calls public is one it reaches.
test("only addresses on the public internet count as public, in every spelling of the internal ones", () => {
  const internal = [
    "0.0.0.0", "10.1.2.3", "100.64.0.1", "100.127.255.254", "127.0.0.1", "127.255.0.9", "169.254.169.254",
    "172.16.0.1", "172.31.255.255", "192.0.0.8", "192.0.2.10", "192.168.1.10", "198.51.100.7", "203.0.113.9", "224.0.0.251", "239.255.255.250", "240.0.0.1", "255.255.255.255",
    "::", "::1", "[::1]", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "::127.0.0.1", "64:ff9b::a00:1",
    "64:ff9b:1::8.8.8.8", "2002:c0a8:0101::1", "100::1", "2001::1", "2001:db8::1", "fc00::1", "fd12:3456::1",
    "fe80::1", "fe80::1%eth0", "febf::1", "fec0::1", "ff02::1", "not-an-address", "",
  ];
  const external = [
    "1.1.1.1", "8.8.8.8", "100.63.255.255", "100.128.0.1", "172.15.255.255", "172.32.0.1", "192.0.3.1",
    "192.169.0.1", "198.18.0.1", "223.255.255.255", "2606:4700:4700::1111", "2001:4860:4860::8888",
    "::ffff:8.8.8.8", "64:ff9b::808:808", "2002:0808:0808::1", "[2a00:1450:4001:80b::200e]",
  ];
  expect(internal.filter(isPublicAddress)).toEqual([]);
  expect(external.filter((address) => !isPublicAddress(address))).toEqual([]);
});
