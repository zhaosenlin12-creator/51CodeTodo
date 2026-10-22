import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppShell } from "./app/AppShell";
import { FloatingBall } from "./app/FloatingBall";
import { ContextMenu } from "./app/ContextMenu";

const root = document.getElementById("root");
if (!root) throw new Error("PomeTodo root element is missing");
const windowKind = new URLSearchParams(location.search).get("window");
if (windowKind) document.documentElement.dataset.window = windowKind;
createRoot(root).render(<StrictMode>{windowKind === "floating" ? <FloatingBall/> : windowKind === "floating-preview" ? <FloatingBall previewOnly/> : windowKind === "context-menu" ? <ContextMenu/> : <AppShell />}</StrictMode>);
