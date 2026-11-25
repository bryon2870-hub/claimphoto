// Exposes React as globals for legacy code that uses `React.createElement` and `ReactDOM` directly.
import React from "react";
import * as ReactDOMClient from "react-dom/client";
window.React = React;
window.ReactDOM = ReactDOMClient;
