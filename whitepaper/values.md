# values

**the constraints we design by**

---

these aren't aspirations. they're the principles we use to make decisions when we face tradeoffs. if a design choice violates these, we rethink the design.

---

## 1. user agency first

users control their AI experience. full stop.

**what this means:**

- **choice of AI.** users decide which AI they use — local models, cloud providers, or a mix. websites don't make this choice for them.
- **control over context.** users decide what information websites can access. the default is no access; access requires explicit consent.
- **revocable permissions.** any permission granted can be revoked. users aren't locked into past decisions.
- **portable preferences.** preferences travel with users across websites and (where possible) across browsers.

**where it gets hard:**

user agency can conflict with convenience. "just works" often means making decisions for users. we lean toward agency even when it adds friction — but we try to make the friction as low as possible while maintaining meaningful consent.

---

## 2. privacy by architecture

the best privacy is infrastructure that makes tracking difficult by design.

**what this means:**

- **local-first.** when AI can run locally, data never leaves the device. this isn't a settings toggle — it's the architecture.
- **data minimization.** only the data necessary for a specific operation should be shared.
- **no retention by default.** prompts, responses, and tool results aren't logged unless explicitly requested.
- **origin isolation.** permissions and context are scoped per-origin. website A can't access what you shared with website B.

**where it gets hard:**

cloud models are often more capable than local ones. cross-site context sharing could enable powerful features. we lean toward privacy — but we give users the choice to make different tradeoffs when they understand them.

---

## 3. open standards over lock-in

no single company should own this layer.

**what this means:**

- **open protocols.** we build on MCP. we propose the Web Agent API as an open standard.
- **implementation independence.** anyone should be able to implement this. multiple implementations should interoperate.
- **no walled gardens.** users shouldn't need a particular browser, OS, or AI provider.
- **competitive neutrality.** the standard shouldn't advantage any particular vendor.

**where it gets hard:**

open standards move slower than proprietary ones. a single company can iterate faster than a consortium. we believe the long-term benefits outweigh the short-term speed — but we're willing to ship working implementations first and standardize based on what works.

the LAMP stack didn't win because it was pure. it won because it became easier — and the economics worked. that's the model.

---

## 4. developer accessibility

building AI-powered web experiences shouldn't require AI expertise.

**what this means:**

- **platform infrastructure.** AI capabilities should be as accessible as `fetch()` or `localStorage`.
- **no API key management.** websites shouldn't manage AI API keys. that's mediated by the browser.
- **no inference costs.** websites that expose tools don't pay for inference. the user's AI handles that.
- **progressive enhancement.** sites can add AI features incrementally.

**where it gets hard:**

simplicity can conflict with flexibility. power users want fine-grained control; most developers want it to just work. we aim for simple defaults with opt-in complexity.

---

## 5. transparency and trust

users should understand what's happening.

**what this means:**

- **clear permissions.** we explain what we're asking for in plain language.
- **auditable behavior.** users can see what data has been shared, which tools have been called.
- **no dark patterns.** we don't trick users into consent.
- **accountability.** organizations building this should be held to public commitments.

**where it gets hard:**

showing all the details can overwhelm. hiding them can obscure important information. we aim for layered disclosure — essential information upfront, details available on request.

these systems aren't neutral. they encode values and incentives. the permission model should make the values visible and the incentives legible.

---

## 6. security by default

the default configuration should be secure.

**what this means:**

- **least privilege.** capabilities default to off. permissions are granted per-scope, not in bulk.
- **defense in depth.** multiple layers of protection.
- **secure contexts only.** AI capabilities require HTTPS.
- **rate limiting.** built-in protection against runaway operations.

**where it gets hard:**

more security often means more friction. we lean toward security — but we try to make the secure path smooth.

---

## 7. extensibility

the infrastructure should evolve without breaking what's built.

**what this means:**

- **stable core, extensible edges.** fundamental APIs stay stable; new capabilities are addable.
- **protocol agnosticism.** we build on MCP today; the architecture accommodates new protocols.
- **graceful degradation.** applications detect capabilities and adapt.

**where it gets hard:**

backward compatibility can prevent better designs. we commit to not breaking existing functionality without clear migration paths.

---

## how we use these

when we face a design decision:

1. does this give users more control?
2. does this minimize data exposure?
3. can others implement this?
4. can developers use this without AI expertise?
5. will users understand what's happening?
6. is the default safe?
7. can this evolve without breaking?

if the answer to any is "no," we think hard about whether we're making the right choice.

---

## tell us if we're wrong

we may be missing principles. we may be weighting them incorrectly. we may be failing to see tensions we should address.

[open an issue](https://github.com/anthropics/harbor/issues) · [start a discussion](https://github.com/anthropics/harbor/discussions)

---

*last updated: January 2026*
