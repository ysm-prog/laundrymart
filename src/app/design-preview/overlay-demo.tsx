"use client";

import { useState } from "react";
import { Overlay } from "@/components/overlay";
import { Field, Input, Select } from "@/components/form";
import { Button } from "@/components/ui";

/**
 * The overlay, on a button, so the gallery actually exercises it.
 *
 * Worth rendering rather than describing: the focus trap, the scroll lock and
 * the sheet-versus-dialog switch at `sm` are all behaviours that only show up
 * when the thing is open, and none of them are visible in a static screenshot
 * of a closed component.
 */
export function OverlayDemo() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
        Open the overlay
      </Button>
      <Overlay
        open={open}
        onClose={() => setOpen(false)}
        title="Record a payment"
        description="A centred dialog on a desktop, a bottom sheet on a phone."
        footer={
          <>
            <Button type="button" onClick={() => setOpen(false)}>Save payment</Button>
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Amount" name="demo_amount">
            <Input name="demo_amount" inputMode="decimal" placeholder="0.00" />
          </Field>
          <Field label="Method" name="demo_method">
            <Select name="demo_method" options={[
              { value: "bank", label: "Bank transfer" },
              { value: "card", label: "Card" },
              { value: "cash", label: "Cash" },
            ]} />
          </Field>
          <Field label="Reference" name="demo_reference" hint="Whatever appears on the statement.">
            <Input name="demo_reference" />
          </Field>
        </div>
      </Overlay>
    </>
  );
}
