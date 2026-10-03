use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TreeNode {
    pub id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<TreeNode>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_expanded: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_draggable: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archived_at: Option<i64>,
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tree_node_serializes_frontend_field_names_in_camel_case() {
        let node = TreeNode {
            id: "n1".into(),
            label: "Note".into(),
            children: None,
            is_expanded: Some(true),
            is_draggable: Some(false),
            content: Some("body".into()),
            created_at: Some(11),
            modified_at: Some(22),
            archived_at: Some(33),
        };

        let value = serde_json::to_value(node).expect("serialize");
        assert_eq!(value["isExpanded"], true);
        assert_eq!(value["isDraggable"], false);
        assert_eq!(value["createdAt"], 11);
        assert_eq!(value["modifiedAt"], 22);
        assert_eq!(value["archivedAt"], 33);
        assert!(value.get("archived_at").is_none());
    }
}
