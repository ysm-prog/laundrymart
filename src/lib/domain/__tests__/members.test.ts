import { describe, expect, it } from "vitest";
import {
  defaultStaffId, hasRealName, memberDisplayName, memberNames, staffMembers, withCurrentHolder,
} from "../members";

const ID = "8c2b996b-6507-4556-84c7-ad392648458e";

describe("memberDisplayName", () => {
  it("prefers the name the person was invited under", () => {
    expect(memberDisplayName({
      id: ID, fullName: "Mario Forte", driverName: "M. Forte", email: "mario@example.com",
    })).toBe("Mario Forte");
  });

  it("falls back to the linked driver record rather than asking for the name twice", () => {
    expect(memberDisplayName({
      id: ID, fullName: null, driverName: "Mario Forte", email: "mario@example.com",
    })).toBe("Mario Forte");
  });

  it("falls back to the address, which is at least meaningful", () => {
    expect(memberDisplayName({ id: ID, email: "mario@example.com" })).toBe("mario@example.com");
  });

  it("never invents a name out of the address", () => {
    // `jsmith@` is not "Jsmith". A wrong name reads as a different person.
    expect(memberDisplayName({ id: ID, email: "jsmith@example.com" })).toBe("jsmith@example.com");
  });

  it("shows a short id only when there is nothing else at all", () => {
    expect(memberDisplayName({ id: ID })).toBe("User 8c2b996b…");
  });

  it("treats blank and whitespace metadata as no name", () => {
    expect(memberDisplayName({ id: ID, fullName: "   ", driverName: "", email: "a@b.com" }))
      .toBe("a@b.com");
  });

  it("trims a name that was typed with stray spaces", () => {
    expect(memberDisplayName({ id: ID, fullName: "  Mario Forte " })).toBe("Mario Forte");
  });
});

describe("hasRealName", () => {
  it("is false when all we have is an address", () => {
    expect(hasRealName({ id: ID, email: "mario@example.com" })).toBe(false);
  });

  it("is false when all we have is an id", () => {
    expect(hasRealName({ id: ID })).toBe(false);
  });

  it("is true for a set name and for a linked driver", () => {
    expect(hasRealName({ id: ID, fullName: "Mario Forte" })).toBe(true);
    expect(hasRealName({ id: ID, driverName: "Mario Forte" })).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */

const owner = { id: "u-owner", label: "Test Owner", isPlatformAdmin: false };
const driver = { id: "u-driver", label: "Ada Driver", isPlatformAdmin: false };
const platform = { id: "u-platform", label: "darshan@ctnorwood.com.au", isPlatformAdmin: true };
const everyone = [owner, driver, platform];

describe("staffMembers", () => {
  it("leaves platform administrators out — they administer the deployment, not this laundry", () => {
    expect(staffMembers(everyone).map((m) => m.id)).toEqual(["u-driver", "u-owner"]);
  });

  it("leaves them out even when they are the person signed in", () => {
    // The owner's decision: never in a picker, not even offered to themselves.
    expect(staffMembers([platform])).toEqual([]);
  });

  it("sorts by what the person is called, not by when they joined", () => {
    expect(staffMembers([owner, driver]).map((m) => m.label)).toEqual(["Ada Driver", "Test Owner"]);
  });
});

describe("memberNames", () => {
  it("resolves everybody, platform administrators included", () => {
    // A record has to say who created it. Hiding them from a picker keeps a
    // staff list honest; hiding them from a record would falsify it.
    expect(memberNames(everyone).get("u-platform")).toBe("darshan@ctnorwood.com.au");
  });
});

describe("withCurrentHolder", () => {
  const staff = staffMembers(everyone);

  it("adds a holder the list no longer offers, so a save cannot silently clear them", () => {
    expect(withCurrentHolder(staff, everyone, "u-platform").map((m) => m.id))
      .toEqual(["u-driver", "u-owner", "u-platform"]);
  });

  it("does not duplicate somebody already in the list", () => {
    expect(withCurrentHolder(staff, everyone, "u-driver")).toHaveLength(2);
  });

  it("adds nothing for an unassigned record, or for an id nobody answers to", () => {
    expect(withCurrentHolder(staff, everyone, null)).toHaveLength(2);
    expect(withCurrentHolder(staff, everyone, "u-gone")).toHaveLength(2);
  });
});

describe("defaultStaffId", () => {
  const staff = staffMembers(everyone);

  it("takes the first preference the list actually offers", () => {
    expect(defaultStaffId(staff, "u-platform", "u-driver")).toBe("u-driver");
  });

  it("is undefined when no preference is in the list, so the form asks", () => {
    // Rather than letting the browser select whoever sorts first and recording
    // the wrong person as having handed the laundry over.
    expect(defaultStaffId(staff, "u-platform", null)).toBeUndefined();
  });
});
