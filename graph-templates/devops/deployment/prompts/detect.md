1. Re-render the node with the same reviewed inputs. An empty proposal means all audited outputs are byte-identical and the exact reviewed Dockerfile still exists.
2. If any output differs, inspect the proposed change. The renderer refuses to overwrite different app-owned content; do not infer that an existing custom CI workflow or ECS request is compatible.
