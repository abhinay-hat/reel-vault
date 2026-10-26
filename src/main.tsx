import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router";
import "./app/globals.css";
import Dashboard from "./app/page";
import ItemDetail from "./app/item/[id]/page";
import Messages from "./app/messages/page";
import Thread from "./app/messages/[id]/page";
import ChatPage from "./app/chat/page";
import ConnectPage from "./app/connect/page";
import LoginPage from "./app/login/page";
import AddPage from "./app/add/page";
import IngestPage from "./app/ingest/page";
import BookmarkletPage from "./app/bookmarklet/page";
import { EmptyState } from "./components/EmptyState";
import Shell from "./components/Shell";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/item/:id" element={<ItemDetail />} />
        <Route path="/messages" element={<Messages />} />
        <Route path="/messages/:id" element={<Thread />} />
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/connect" element={<ConnectPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/add" element={<AddPage />} />
        <Route path="/ingest" element={<IngestPage />} />
        <Route path="/bookmarklet" element={<BookmarkletPage />} />
        <Route
          path="*"
          element={
            <Shell>
              <EmptyState title="No such card" description="That page is not part of the stack." />
            </Shell>
          }
        />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
