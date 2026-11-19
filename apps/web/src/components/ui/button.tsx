import { Slot } from "@radix-ui/react-slot";
import { cva,type VariantProps } from "class-variance-authority";
import type {ComponentProps} from "react";
import {cn} from "../../lib/utils";
const variants=cva("deck-btn",{variants:{variant:{default:"btn-primary",ghost:"btn-ghost",outline:"btn-outline"},size:{default:"btn-default",icon:"btn-icon",sm:"btn-sm"}},defaultVariants:{variant:"default",size:"default"}});
export function Button({className,variant,size,asChild=false,...props}:ComponentProps<"button">&VariantProps<typeof variants>&{asChild?:boolean}) {
  const Comp=asChild?Slot:"button";
  return <Comp className={cn(variants({variant,size}),className)} {...props}/>;
}
