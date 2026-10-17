import { useState } from "react";
import { useNavigate } from "react-router-dom";
import axios from "axios";
import { toast } from "sonner";
import { Mail, Send } from "lucide-react";
import { API } from "@/lib/api";
import { useAuth } from "@/App";
import { useReveal } from "@/lib/motion";
import { useSeo, breadcrumbJsonLd, SITE_ORIGIN } from "@/lib/seo";
import { track } from "@/lib/analytics";
import Breadcrumbs from "@/components/marketing/Breadcrumbs";
import RelatedPages from "@/components/marketing/RelatedPages";
import { PixelFooter, PixelNav, SectionIndex } from "@/components/marketing/pixel";

const TOPICS = [
  ["integration", "Integrating the SDK"],
  ["underwriting", "Underwriting and staking"],
  ["security", "Security disclosure"],
  ["other", "Something else"],
];

const TRAIL = [
  ["Home", "/"],
  ["Contact", "/contact"],
];

const EMPTY = { name: "", email: "", topic: "integration", message: "" };

export default function Contact() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const reveal = useReveal({ step: 60 });
  const [form, setForm] = useState(EMPTY);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  useSeo({
    title: "Contact the team",
    description:
      "Questions about integrating the gate, underwriting missions or reporting a security issue. Messages are routed to the AVAIRA team by email.",
    path: "/contact",
    image: "/og/og-contact.png",
    imageAlt: "AVAIRA Protocol contact card over a pixel lattice of connected nodes",
    jsonLd: [
      {
        "@context": "https://schema.org",
        "@type": "ContactPage",
        name: "Contact AVAIRA Protocol",
        url: `${SITE_ORIGIN}/contact`,
        description: "Contact the team behind the AVAIRA execution gate.",
      },
      breadcrumbJsonLd(TRAIL),
    ],
  });

  const goToConsole = () => {
    if (user) {
      navigate("/dashboard");
      return;
    }
    navigate("/login?redirect=/dashboard");
  };

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    if (sending) return;
    setSending(true);
    try {
      await axios.post(`${API}/contact`, form);
      setSent(true);
      setForm(EMPTY);
      track("contact_submitted", { topic: form.topic });
      toast.success("Message sent", {
        description: "It has been routed to the team. Expect a reply at the address you gave.",
      });
    } catch (err) {
      const detail =
        (err && err.response && err.response.data && err.response.data.detail) ||
        "The API did not accept the message. Try again in a minute.";
      toast.error("Message not sent", { description: String(detail) });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="px-site" ref={reveal} data-testid="contact-page">
      <PixelNav onLaunch={goToConsole} onSignIn={() => navigate("/login")} />

      <header className="px-page-head" id="top">
        <span className="px-page-head-veil" aria-hidden="true" />
        <div className="px-wrap px-page-head-inner">
          <Breadcrumbs trail={TRAIL} />
          <SectionIndex n="07" label="Contact" />
          <h1 className="px-dot px-display px-page-title" data-reveal>
            Talk to the team.
          </h1>
          <p className="px-body px-page-lede" data-reveal style={{ maxWidth: "58ch" }}>
            Integration questions, underwriting, a disclosure, or something the docs did not answer.
            The form below lands in the team inbox; security reports can also follow the process in
            SECURITY.md.
          </p>
        </div>
      </header>

      <section className="px-section px-section-flat" id="form">
        <div className="px-wrap">
          <SectionIndex n="07.1" label="Message" />

          {sent ? (
            <div
              data-testid="contact-success"
              style={{ border: "1px solid rgba(255,255,255,0.14)", padding: "2rem", marginTop: "2.5rem", maxWidth: "640px" }}
            >
              <p className="px-label">Delivered</p>
              <h2 className="px-dot px-h3" style={{ marginTop: "0.75rem" }}>Message sent.</h2>
              <p className="px-body" style={{ marginTop: "0.75rem" }}>
                The team reads every message and replies to the address you provided. If the matter is
                a security disclosure, you will hear back with a tracking reference first.
              </p>
              <button type="button" className="px-btn px-btn-quiet" style={{ marginTop: "1.5rem" }} onClick={() => setSent(false)} data-testid="contact-again">
                Send another message
              </button>
            </div>
          ) : (
            <form onSubmit={submit} style={{ marginTop: "2.5rem", maxWidth: "640px" }} data-testid="contact-form" data-reveal>
              <div style={{ display: "grid", gap: "1.1rem" }}>
                <label className="px-field">
                  <span className="px-label" style={{ display: "block", marginBottom: "0.4rem" }}>Name</span>
                  <input
                    required
                    maxLength={120}
                    value={form.name}
                    onChange={set("name")}
                    autoComplete="name"
                    data-testid="contact-name"
                    className="px-input"
                    style={inputStyle}
                  />
                </label>

                <label className="px-field">
                  <span className="px-label" style={{ display: "block", marginBottom: "0.4rem" }}>Email</span>
                  <input
                    required
                    type="email"
                    maxLength={254}
                    value={form.email}
                    onChange={set("email")}
                    autoComplete="email"
                    data-testid="contact-email"
                    className="px-input"
                    style={inputStyle}
                  />
                </label>

                <label className="px-field">
                  <span className="px-label" style={{ display: "block", marginBottom: "0.4rem" }}>Topic</span>
                  <select value={form.topic} onChange={set("topic")} data-testid="contact-topic" className="px-input" style={inputStyle}>
                    {TOPICS.map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                </label>

                <label className="px-field">
                  <span className="px-label" style={{ display: "block", marginBottom: "0.4rem" }}>Message</span>
                  <textarea
                    required
                    minLength={20}
                    maxLength={4000}
                    rows={7}
                    value={form.message}
                    onChange={set("message")}
                    data-testid="contact-message"
                    className="px-input"
                    style={{ ...inputStyle, resize: "vertical" }}
                  />
                </label>
              </div>

              <button type="submit" className="px-btn px-btn-accent px-btn-lg" style={{ marginTop: "1.5rem" }} disabled={sending} data-testid="contact-submit">
                {sending ? "Sending" : "Send message"}
                <Send size={14} strokeWidth={2} aria-hidden="true" />
              </button>

              <p className="px-mono px-mute" style={{ marginTop: "1rem", fontSize: "11px", display: "flex", alignItems: "center", gap: "8px" }}>
                <Mail size={12} strokeWidth={2} aria-hidden="true" />
                Routed to the team inbox by email. No mailing list, no follow-up you did not ask for.
              </p>
            </form>
          )}
        </div>
      </section>

      <RelatedPages items={["docs", "gate", "evidence"]} />

      <PixelFooter />
    </div>
  );
}

const inputStyle = {
  width: "100%",
  background: "#0B0D12",
  border: "1px solid rgba(255,255,255,0.18)",
  color: "#F5F6F8",
  fontFamily: "'IBM Plex Mono', ui-monospace, monospace",
  fontSize: "13px",
  padding: "0.7rem 0.8rem",
  outline: "none",
};
